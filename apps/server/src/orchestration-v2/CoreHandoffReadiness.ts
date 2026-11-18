import * as Digest from "effect/crypto/Digest";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import {
  HandoffReadiness,
  HandoffReadinessRecords,
  type HandoffReadinessFrame,
  type HandoffProviderObservation,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Threads from "./ThreadManagementService.ts";
import * as Projects from "./ProjectStore.ts";
import * as Sessions from "./ProviderSessionManager.ts";
import * as Git from "../git/GitManager.ts";
import * as Terminals from "../terminal/Manager.ts";
import * as Outbox from "./EffectOutbox.ts";
import { handoffId } from "./CoreHandoff.ts";
import type {
  ProjectionRecordField,
  ProjectionRecords,
  ProjectionRecordFilter,
} from "./ProjectionStore.ts";

const fields = Object.keys(HandoffReadinessRecords.fields).filter(
  (key) => key !== "thread",
) as ReadonlyArray<ProjectionRecordField>;
const isRecords = Schema.is(HandoffReadinessRecords);
const encodeUnknown = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const frameCodec = Schema.fromJsonString(Schema.toCodecJson(HandoffReadinessFrameSchema));
const encodeFrame = Schema.encodeEffect(frameCodec);
const snapshotCodec = Schema.fromJsonString(Schema.toCodecJson(HandoffReadiness));
const encodeSnapshot = Schema.encodeEffect(snapshotCodec);
const decodeSnapshot = Schema.decodeEffect(snapshotCodec);
const active = new Set(["preparing", "queued", "starting", "running", "waiting"]);

const classifyReadiness = (
  frame: HandoffReadinessFrame,
  stable: boolean,
): HandoffReadiness["classification"] =>
  frame.blockers.length > 0
    ? "known_blocked"
    : !stable || frame.unknowns.length > 0
      ? "unknown"
      : frame.manualReview.length > 0
        ? "manual_review"
        : "automatically_eligible";

/** Two bounded observations, no subscriptions, launch, settlement, requeue or provider activity touch. */
export interface HandoffReaders {
  readonly readHandoffRecords: <K extends ProjectionRecordField>(
    id: ThreadId,
    fields: ReadonlyArray<K>,
    filter?: ProjectionRecordFilter,
  ) => Effect.Effect<ProjectionRecords<K>, Error>;
  readonly readHandoffChildIds: (id: ThreadId) => Effect.Effect<ReadonlyArray<ThreadId>, Error>;
  readonly getThreadEventSequence: (id: ThreadId) => Effect.Effect<number, Error>;
}

export const queryHandoffReadinessWithReaders = Effect.fn("CoreHandoff.observe")(function* (
  sourceThreadId: ThreadId,
  expectedGeneration: string | undefined,
  threads: HandoffReaders,
  reviewId?: string,
  ownProviderStart?: { readonly sessionId: string; readonly busyTurnKey: string },
  reviewedChildSequences?: ReadonlyArray<{ readonly id: ThreadId; readonly sequence: number }>,
) {
  const crypto = yield* Digest.Digest;
  const fingerprint = (text: string) =>
    crypto
      .digest(Digest.sha256, new TextEncoder().encode(text))
      .pipe(
        Effect.map((bytes) =>
          Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
        ),
      );
  const projects = yield* Projects.ProjectStoreV2;
  const sessions = yield* Sessions.ProviderSessionManagerV2;
  const git = yield* Git.GitManager;
  const terminals = yield* Terminals.TerminalManager;
  const outbox = yield* Outbox.EffectOutboxV2;
  const observe = Effect.fnUntraced(function* () {
    const blockers: string[] = [],
      unknowns: string[] = [],
      manualReview: string[] = [];
    const read = <A, E>(label: string, effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.catchCause(() => {
          unknowns.push(`${label}: read failed`);
          return Effect.succeed(null);
        }),
      );
    const readRecords = (id: ThreadId) =>
      read(
        `records:${id}`,
        Effect.gen(function* () {
          const records = yield* threads.readHandoffRecords(id, fields);
          for (const field of fields)
            if (!Array.isArray(records[field]))
              return yield* new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: `Missing ${field}`,
              });
          for (const provider of records.providerThreads)
            if (!Array.isArray(provider.pendingBackgroundTasks))
              unknowns.push(`${id}:${provider.id}: missing pendingBackgroundTasks`);
          if (!isRecords(records))
            return yield* new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "Invalid owner records",
            });
          return records;
        }),
      );
    const sourceSequence = yield* read(
      "source sequence",
      threads.getThreadEventSequence(sourceThreadId),
    );
    const rawSourceRecords = yield* readRecords(sourceThreadId);
    const sourceRecords =
      rawSourceRecords === null || reviewId === undefined
        ? rawSourceRecords
        : {
            ...rawSourceRecords,
            runtimeRequests: rawSourceRecords.runtimeRequests.filter(
              (request) => request.id !== reviewId,
            ),
          };
    if (sourceRecords !== null) {
      if (sourceRecords.thread.handoffStopCommandId !== undefined)
        blockers.push("The handoff was explicitly stopped");
      if (
        sourceRecords.thread.handoffTransfer === undefined &&
        (sourceRecords.thread.archivedAt !== null ||
          sourceRecords.thread.settledOverride === "settled" ||
          sourceRecords.thread.settledAt !== null)
      )
        blockers.push("The source was explicitly archived or settled");
    }
    const observedChildIds = yield* read(
      "app-owned child index",
      threads.readHandoffChildIds(sourceThreadId),
    );
    const childIds = Array.isArray(observedChildIds) ? observedChildIds : null;
    if (childIds === null && observedChildIds !== null)
      unknowns.push("Missing app-owned child array");
    const children = yield* Effect.forEach([...(childIds ?? [])].sort(), (id) =>
      Effect.gen(function* () {
        return {
          id,
          sequence: yield* read(`child sequence:${id}`, threads.getThreadEventSequence(id)),
          records: yield* readRecords(id),
          nestedIds: yield* read(
            `nested app-owned children:${id}`,
            threads.readHandoffChildIds(id),
          ),
        };
      }),
    );
    for (const child of children) {
      if (child.nestedIds === null || child.nestedIds.length > 0)
        unknowns.push(`${child.id}: nested app-owned owner coverage is not established`);
    }
    const row = yield* read("parked handoff", outbox.get(handoffId(sourceThreadId)));
    const request =
      row === null ? null : Option.isSome(row) ? yield* encodeUnknown(row.value) : null;
    if (row !== null && Option.isNone(row)) unknowns.push("No durable handoff request");
    if (row !== null && Option.isSome(row) && row.value.status === "cancelled")
      blockers.push("Durable handoff was cancelled");
    if (
      sourceRecords?.thread.handoffTransfer !== undefined &&
      (reviewId === undefined ||
        sourceRecords.thread.handoffTransfer.requestId !== reviewId ||
        sourceRecords.thread.handoffTransfer.state === "cancelled")
    )
      blockers.push("Source already has a reserved or terminal handoff pair");
    if (
      sourceRecords !== null &&
      (sourceRecords.thread.handoffSourceThreadId !== undefined ||
        sourceRecords.thread.lineage.parentThreadId !== null)
    )
      blockers.push("This source's inherited ownership is not supported by guarded transfer");
    const parkedRequest =
      row !== null && Option.isSome(row) && row.value.request.type === "thread.handoff"
        ? row.value.request
        : null;
    if (row !== null && Option.isSome(row) && parkedRequest === null)
      blockers.push("Durable request has the wrong effect type");
    let cwd = sourceRecords?.thread.worktreePath ?? null;
    if (sourceRecords !== null && cwd === null) {
      const project = yield* read("project", projects.get(sourceRecords.thread.projectId));
      cwd = project !== null && Option.isSome(project) ? project.value.workspaceRoot : null;
    }
    if (cwd === null) unknowns.push("Physical checkout path unavailable");
    const checkpoint = sourceRecords?.checkpoints
      .filter((item) => item.status === "ready")
      .toSorted((a, b) => b.ordinalWithinScope - a.ordinalWithinScope)[0];
    const workspace =
      cwd === null
        ? null
        : yield* read(
            "physical Git/checkpoint",
            git.observeHandoffWorkspace(cwd, checkpoint?.ref ?? null),
          );
    if (workspace !== null) {
      if (workspace.checkpointError !== null) unknowns.push(workspace.checkpointError);
      if (workspace.branch !== sourceRecords?.thread.branch)
        blockers.push("Physical branch differs from source metadata");
      if (
        row !== null &&
        Option.isSome(row) &&
        row.value.request.type === "thread.handoff" &&
        workspace.branch !== row.value.request.branch
      )
        blockers.push("Physical branch differs from parked request");
      if (workspace.status !== "" && workspace.checkpointMatches !== true)
        blockers.push("Dirty workspace lacks a verified matching checkpoint");
      if (workspace.untracked !== "")
        unknowns.push("Untracked file contents not covered by workspace generation");
      if (workspace.submodules.split("\n").some((line) => line.startsWith("160000 ")))
        unknowns.push("Submodule working trees not covered");
      if (workspace.branch === null) blockers.push("Detached HEAD");
    }
    const providers: HandoffProviderObservation[] = [];
    for (const records of [sourceRecords, ...children.map((child) => child.records)]) {
      if (records === null) continue;
      if (
        records.thread.deletedAt !== null ||
        records.thread.agentExecutionIntent?.restrictedTools !== undefined ||
        records.thread.linkOrigin !== undefined
      )
        blockers.push(`${records.thread.id}: restricted/deleted/linked source`);
      if (records.runs.some((run) => active.has(run.status)))
        blockers.push(`${records.thread.id}: active or queued run`);
      if (records.runtimeRequests.some((request) => request.status === "pending"))
        blockers.push(`${records.thread.id}: pending runtime request/approval`);
      if (records.subagents.some((task) => ["pending", "running", "waiting"].includes(task.status)))
        blockers.push(`${records.thread.id}: active delegated task`);
      if (records.nodes.some((node) => ["pending", "running", "waiting"].includes(node.status)))
        blockers.push(`${records.thread.id}: active execution node`);
      if (
        records.providerTurns.some((turn) =>
          ["starting", "running", "waiting"].includes(turn.status),
        )
      )
        blockers.push(`${records.thread.id}: active provider turn`);
      if (records.providerThreads.length === 0)
        unknowns.push(`${records.thread.id}: no provider thread coverage`);
      for (const provider of records.providerThreads) {
        if (provider.status === "active" || (provider.pendingBackgroundTasks?.length ?? 0) > 0)
          blockers.push(`${provider.id}: active provider or background tasks`);
        const result =
          provider.providerSessionId === null
            ? null
            : yield* read(
                `provider:${provider.id}`,
                sessions.observeHandoffSession(provider.providerSessionId),
              );
        const entry = result !== null && Option.isSome(result) ? result.value : null;
        if (
          entry !== null &&
          (entry.runtime.providerSessionId !== provider.providerSessionId ||
            entry.runtime.instanceId !== provider.providerInstanceId ||
            entry.runtime.driver !== provider.driver)
        )
          unknowns.push(`${provider.id}: live provider identity does not match stored owner`);
        const errors: string[] = [];
        const probe = (effect: Effect.Effect<boolean> | undefined) =>
          effect === undefined
            ? Effect.succeed(null)
            : effect.pipe(
                Effect.catchCause(() => {
                  errors.push("Live probe failed");
                  return Effect.succeed(null);
                }),
              );
        const sessionProbe = yield* probe(entry?.runtime.hasPendingBackgroundWork);
        const threadProbe = yield* probe(
          entry?.runtime.hasPendingBackgroundWorkForThread?.(provider, { includeSubagents: true }),
        );
        const supported =
          provider.driver === "codex" ||
          provider.driver === "claude" ||
          provider.driver === "claudeAgent";
        const complete =
          entry?.runtime.handoffReadinessCoverage?.scope === "all-app-owned-work" &&
          entry.runtime.handoffReadinessCoverage.nativeSubagents === true &&
          entry.runtime.handoffReadinessCoverage.detachedTasks === true;
        const limitations = complete
          ? []
          : supported
            ? [
                "Adapter-reported work only; unreported native/detached work requires separate human review",
              ]
            : ["Provider coverage not established for automatic handoff"];
        const observation = {
          providerThreadId: provider.id,
          driver: provider.driver,
          sessionId: provider.providerSessionId,
          live: entry !== null,
          idleGeneration: entry?.idleGeneration ?? null,
          busyTurns: (entry?.busyTurns ?? []).filter(
            (key) =>
              ownProviderStart?.sessionId !== provider.providerSessionId ||
              key !== ownProviderStart.busyTurnKey,
          ),
          sessionProbe,
          threadProbe,
          errors,
          limitations,
          completeAppOwnedCoverage: complete,
          coverage: supported
            ? [
                provider.driver === "codex"
                  ? "Session commands, dynamic tools, captures, images and tracked native subagents; thread retained descendant work"
                  : "Session wakeups, task rosters, tracked native subagents and wake buffers; thread live-process subagents requested",
              ]
            : [],
        };
        providers.push(observation);
        if (sessionProbe === true || threadProbe === true || observation.busyTurns.length > 0)
          blockers.push(`${provider.id}: live work observed`);
        if (entry === null || sessionProbe === null || threadProbe === null || !supported)
          unknowns.push(`${provider.id}: incomplete live probe coverage`);
        manualReview.push(...limitations.map((item) => `${provider.id}: ${item}`));
      }
    }
    const observedTerminals =
      cwd === null
        ? null
        : yield* read(
            "managed terminals",
            terminals.observeHandoff([sourceThreadId, ...(childIds ?? [])], cwd),
          );
    const terminalObservations = Array.isArray(observedTerminals) ? observedTerminals : null;
    if (terminalObservations === null && observedTerminals !== null)
      unknowns.push("Missing managed terminal array");
    for (const terminal of terminalObservations ?? []) {
      if (terminal.status === "starting" || terminal.running === true || terminal.cachedRunning)
        blockers.push(`${terminal.terminalId}: managed subprocess observed`);
      if (terminal.running === null || terminal.error !== null)
        unknowns.push(`${terminal.terminalId}: incomplete terminal observation`);
    }

    return {
      sourceRecords,
      sourceSequence,
      childIds,
      children,
      request,
      parkedRequest,
      workspace,
      providers,
      terminals: terminalObservations,
      blockers,
      unknowns,
      manualReview,
    } satisfies HandoffReadinessFrame;
  });
  const before = yield* observe();
  const after = yield* observe();
  const beforeText = yield* encodeFrame(before);
  const afterText = yield* encodeFrame(after);
  const stable = beforeText === afterText;
  const classification =
    before.blockers.length > 0 ? "known_blocked" : classifyReadiness(after, stable);
  const generation = yield* fingerprint(beforeText + "\n" + afterText);
  const normalizedThread =
    after.sourceRecords === null
      ? null
      : (({
          updatedAt: _updatedAt,
          settledAt: _settledAt,
          settledOverride: _settledOverride,
          handoffTransfer: _handoffTransfer,
          ...thread
        }) => thread)(after.sourceRecords.thread);
  const normalized = {
    ...after,
    sourceSequence: null,
    children: after.children.map((child) => ({
      ...child,
      sequence:
        reviewedChildSequences?.find(({ id }) => id === child.id)?.sequence ?? child.sequence,
    })),
    request: null,
    sourceRecords:
      after.sourceRecords === null ? null : { ...after.sourceRecords, thread: normalizedThread },
  };
  const releaseEvidence = yield* fingerprint(yield* encodeUnknown(normalized));
  const result: HandoffReadiness = {
    releaseEvidence,
    sourceThreadId,
    observationalOnly: true,
    transferAuthorized: false,
    classification,
    generation,
    expectedGenerationMatches:
      expectedGeneration === undefined ? null : expectedGeneration === generation,
    ownershipScope: "app-owned-only; arbitrary external processes excluded",
    stable,
    before,
    after,
  };
  const snapshot = yield* encodeSnapshot(result).pipe(Effect.flatMap(decodeSnapshot));
  return freeze(snapshot);
});
import { HandoffReadinessFrame as HandoffReadinessFrameSchema } from "@t3tools/contracts";
function freeze<A>(value: A): A {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export const summarizeHandoffReadiness = (snapshot: HandoffReadiness) => {
  const summarize = (key: "blockers" | "unknowns" | "manualReview") => {
    const reasons = [...new Set([...snapshot.before[key], ...snapshot.after[key]])];
    return {
      total: reasons.length,
      items: reasons.slice(0, 4).map((reason) => reason.slice(0, 48)),
      detailsOmitted: reasons.length > 4 || reasons.some((reason) => reason.length > 48),
    };
  };
  return {
    observationalOnly: snapshot.observationalOnly,
    transferAuthorized: snapshot.transferAuthorized,
    classification: snapshot.classification,
    generation: snapshot.generation,
    expectedGenerationMatches: snapshot.expectedGenerationMatches,
    stable: snapshot.stable,
    ownershipScope: snapshot.ownershipScope,
    blockers: summarize("blockers"),
    unknowns: summarize("unknowns"),
    manualReview: summarize("manualReview"),
    evidence: { kind: "revalidate_generation" as const, generation: snapshot.generation },
  };
};

export const queryHandoffReadiness = Effect.fn("CoreHandoff.readiness")(function* (
  sourceThreadId: ThreadId,
  expectedGeneration?: string,
) {
  const threads = yield* Threads.ThreadManagementService;
  return yield* queryHandoffReadinessWithReaders(sourceThreadId, expectedGeneration, threads);
});
