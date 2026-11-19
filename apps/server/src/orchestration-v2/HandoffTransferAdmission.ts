import { automaticHandoffDeclaration } from "@t3tools/contracts";
import { ProviderTurnStartModels } from "./ProviderTurnStartService.ts";
import { agentModelPolicy } from "./AgentModelPolicy.ts";
import {
  HandoffApprovalCapability,
  HandoffInput,
  type HandoffRequest,
  OrchestrationV2ProviderSession,
  type OrchestrationV2AppThread,
  type OrchestrationV2StoredEvent,
  type ProviderSessionId,
  ThreadId,
  type RuntimeRequestId,
  type RunId,
  CommandId,
  EventId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as DateTime from "effect/DateTime";
import * as Digest from "effect/crypto/Digest";
import * as Git from "../git/GitManager.ts";
import * as Terminals from "../terminal/Manager.ts";
import * as Sessions from "./ProviderSessionManager.ts";
import * as Projects from "./ProjectStore.ts";
import * as Outbox from "./EffectOutbox.ts";
import * as Projections from "./ProjectionStore.ts";
import * as Events from "./EventStore.ts";
import * as Sink from "./EventSink.ts";
import * as Receipts from "./CommandReceiptStore.ts";
import * as Executor from "./ThreadCommandExecutor.ts";
import { queryHandoffReadinessWithReaders } from "./CoreHandoffReadiness.ts";
import { modelSelectionsEqual } from "@t3tools/shared/model";

export class HandoffTransferError extends Schema.TaggedError<HandoffTransferError>()(
  "HandoffTransferError",
  {
    sourceThreadId: Schema.String,
    stage: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const TransferReleaseAuthority = Context.Reference<boolean>(
  "t3/handoff-transfer/release-authority",
  { defaultValue: () => false },
);
export const hasTransferReleaseAuthority = TransferReleaseAuthority;
export const withTransferReleaseAuthority = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, TransferReleaseAuthority, true);

/** The release and each bounded recovery own exactly one start effect. */
export const handoffStartEffectId = (
  pair: NonNullable<OrchestrationV2AppThread["handoffTransfer"]>,
) =>
  `effect:handoff-transfer:${pair.requestId}:${pair.recoveryCount ? `recover:${pair.recoveryCount}` : "release"}:provider-turn.start:${pair.runId}`;

type Transfer = NonNullable<OrchestrationV2AppThread["handoffTransfer"]>;

export const handoffRecoveryCommand = (pair: Transfer, count: number) =>
  CommandId.make(`handoff-transfer:${pair.requestId}:recover:${count}`);

export const handoffParkRecoveryCommand = (pair: Transfer) =>
  CommandId.make(`${handoffRecoveryCommand(pair, pair.recoveryCount ?? 0)}:park`);

export const handoffStartupStopCommand = (pair: Transfer, ownerId: ThreadId) =>
  CommandId.make(
    `handoff-transfer:${JSON.stringify([pair.sourceThreadId, pair.requestId, pair.generation, pair.runId, ownerId])}:startup-stop`,
  );

export const handoffProviderOpenCommand = (pair: Transfer) =>
  CommandId.make(`handoff-transfer:${pair.requestId}:provider-open:${pair.recoveryCount ?? 0}`);

interface ProviderStart {
  readonly sessionId: string;
  readonly busyTurnKey: string;
  readonly sessionWrite?: {
    readonly id: EventId;
    readonly payload: OrchestrationV2ProviderSession;
  };
}

interface SessionWriteExpectation {
  readonly id: ProviderSessionId;
  readonly afterSequence: number;
  readonly throughSequence: number;
}

export const stopReadyHandoffSession = (
  before: OrchestrationV2ProviderSession,
  now: DateTime.Utc,
): OrchestrationV2ProviderSession => ({
  ...before,
  status: "stopped",
  ...(before.extensionStatuses === undefined ? {} : { extensionStatuses: [] }),
  updatedAt: now,
  lastError: null,
});

export const sameHandoffSession = Schema.toEquivalence(OrchestrationV2ProviderSession);

export interface AcceptedHandoff {
  readonly source: OrchestrationV2AppThread;
  readonly review: HandoffApprovalCapability;
  readonly request: HandoffRequest;
  readonly sessionWrites: ReadonlyArray<SessionWriteExpectation>;
  readonly parkedBootstrapEventId?: EventId;
  readonly expectedSequences: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly sequence: number;
  }>;
}
export class HandoffTransferAdmission extends Context.Service<
  HandoffTransferAdmission,
  {
    readonly canForceFollowup: (threadId: ThreadId) => Effect.Effect<boolean, HandoffTransferError>;
    readonly inspect: (
      sourceId: ThreadId,
      requestId: RuntimeRequestId,
      generation: string,
      ownProviderStart?: ProviderStart,
    ) => Effect.Effect<AcceptedHandoff, HandoffTransferError>;
    readonly inspectRecovery: (
      sourceId: ThreadId,
      requestId: RuntimeRequestId,
      generation: string,
      lostReplacement?: { readonly completedAt: string },
    ) => Effect.Effect<AcceptedHandoff, HandoffTransferError>;
    readonly assertDispatch: (
      threadId: ThreadId,
      commandType: string,
    ) => Effect.Effect<void, HandoffTransferError>;
    readonly start: (
      threadId: ThreadId,
      runId: RunId,
      ownProviderStart?: ProviderStart,
    ) => Effect.Effect<void, HandoffTransferError>;
  }
>()("t3/orchestration-v2/HandoffTransferAdmission") {}

const encodeFollowupObservation = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeHandoff = Schema.encodeEffect(Schema.fromJsonString(HandoffInput));
const inertCommands = new Set([
  "thread.visit",
  "thread.mark-unread",
  "thread.pin",
  "thread.unpin",
  "thread.pin.reorder",
  "thread.active.reorder",
  "thread.tag.set",
]);
const isHandoffTransferError = Schema.is(HandoffTransferError);
const reviewsEqual = Schema.toEquivalence(HandoffApprovalCapability);

export const assertHandoffDispatch = Effect.fn("HandoffTransferAdmission.assertDispatch")(
  function* (
    projections: Projections.ProjectionStoreV2Shape,
    threadId: ThreadId,
    commandType: string,
  ) {
    const failed = (sourceThreadId: ThreadId, stage: string) =>
      new HandoffTransferError({ sourceThreadId, stage });
    if (commandType.startsWith("handoff.transfer.") || inertCommands.has(commandType)) return;
    const thread = yield* projections.getThreadShell(threadId);
    const candidateSourceId =
      threadId.startsWith("core-handoff:") && threadId.endsWith(":successor")
        ? ThreadId.make(threadId.slice("core-handoff:".length, -":successor".length))
        : undefined;
    if (candidateSourceId !== undefined) {
      const current = thread === null ? null : yield* projections.getThread(threadId);
      if (current?.handoffSourceThreadId !== candidateSourceId)
        return yield* failed(candidateSourceId, "successor-unreserved");
    }
    if (thread === null) return;
    // Full payloads retain the pair binding; shells deliberately do not grow a second authority copy.
    let current = yield* projections.getThread(threadId);
    if (current.handoffSourceThreadId !== undefined) {
      const source = yield* projections.getThread(current.handoffSourceThreadId);
      const pair = source.handoffTransfer;
      if (!pair || pair.successorThreadId !== threadId || pair.state === "cancelled")
        return yield* failed(threadId, "successor-fenced");
      if (
        pair.state !== "started" &&
        commandType !== "thread.stop" &&
        commandType !== "prepared-run.release"
      )
        return yield* failed(source.id, "successor-not-released");
    }
    for (let depth = 0; depth < 32; depth++) {
      if (current.handoffTransfer && current.handoffTransfer.state !== "cancelled") {
        if (
          commandType === "thread.stop" &&
          current.handoffTransfer.state !== "started" &&
          current.id === threadId
        )
          return;
        return yield* failed(current.id, "source-fenced");
      }
      const parent = current.lineage.parentThreadId;
      if (parent === null) return;
      current = yield* projections.getThread(parent);
    }
    return yield* failed(threadId, "ancestry");
  },
  Effect.mapError((cause) =>
    isHandoffTransferError(cause)
      ? cause
      : new HandoffTransferError({ sourceThreadId: "unknown", stage: "dispatch", cause }),
  ),
);

const make = Effect.gen(function* () {
  const projections = yield* Projections.ProjectionStoreV2;
  const events = yield* Events.EventStoreV2;
  const sink = yield* Sink.EventSinkV2;
  const receipts = yield* Receipts.CommandReceiptStoreV2;
  const executor = yield* Executor.ThreadCommandExecutor;
  const outbox = yield* Outbox.EffectOutboxV2;
  const projects = yield* Projects.ProjectStoreV2;
  const sessions = yield* Sessions.ProviderSessionManagerV2;
  const git = yield* Effect.serviceOption(Git.GitManager);
  const terminals = yield* Effect.serviceOption(Terminals.TerminalManager);
  const digest = yield* Digest.Digest;
  const models = yield* ProviderTurnStartModels;
  const failed = (sourceThreadId: string, stage: string) =>
    new HandoffTransferError({ sourceThreadId, stage });
  const inspect = Effect.fn("HandoffTransferAdmission.inspect")(
    function* (
      sourceId: ThreadId,
      requestId: RuntimeRequestId,
      generation: string,
      ownProviderStart?: ProviderStart,
      reobservePhysical = true,
      lostReplacement?: { readonly completedAt: string },
    ) {
      const sourceWatermark = yield* events.latestSequence({ threadId: sourceId });
      const source = yield* projections.getThread(sourceId);
      if (source.handoffStopCommandId !== undefined)
        return yield* failed(sourceId, "explicitly-stopped");
      const decision = yield* projections.getRuntimeRequest(sourceId, requestId);
      const parked = yield* outbox.get(`core-handoff:${sourceId}`);
      if (
        (Option.isSome(parked) && parked.value.status === "cancelled") ||
        decision?.responseCapability.type !== "handoff" ||
        decision.status !== "resolved" ||
        decision.decision !== "accept" ||
        decision.responseCapability.generation !== generation ||
        !decision.responseCapability.releaseEvidence ||
        decision.responseCapability.sourceThreadId !== sourceId ||
        Option.isNone(parked) ||
        parked.value.request.type !== "thread.handoff"
      )
        return yield* failed(sourceId, "accepted-decision");
      if (
        source.archivedAt !== null ||
        (!["released", "started"].includes(source.handoffTransfer?.state ?? "") &&
          (source.settledOverride === "settled" || source.settledAt !== null)) ||
        (source.handoffTransfer === undefined &&
          (yield* projections.getThreadShell(parked.value.request.successorThreadId)) !== null)
      )
        return yield* failed(sourceId, "stale-source-or-successor");
      const sourceRuns = yield* projections.getThreadRecords(sourceId, ["runs"]);
      if (
        sourceRuns.runs.some(
          (run) =>
            run.startedAt !== null &&
            DateTime.toEpochMillis(run.startedAt) > Date.parse(parked.value.createdAt),
        )
      )
        return yield* failed(sourceId, "newer-source-run");
      if (parked.value.request.target !== undefined) {
        const target = parked.value.request.target;
        const project = yield* projects.get(target.projectId);
        if (Option.isNone(project) || project.value.workspaceRoot !== target.workspaceRoot)
          return yield* failed(sourceId, "target-project-changed");
      }
      const review = decision.responseCapability;
      const request = parked.value.request;
      if (
        request.successorThreadId !== ThreadId.make(`core-handoff:${sourceId}:successor`) ||
        review.successorThreadId !== request.successorThreadId ||
        source.id !== request.sourceThreadId ||
        source.projectId !== request.projectId ||
        source.branch !== request.branch ||
        source.worktreePath !== request.worktreePath ||
        !modelSelectionsEqual(source.modelSelection, request.modelSelection) ||
        source.runtimeMode !== request.runtimeMode ||
        source.interactionMode !== request.interactionMode ||
        review.blockers.length ||
        review.unknowns.length
      )
        return yield* failed(sourceId, "tuple");
      const later = yield* events
        .read({
          threadId: sourceId,
          afterSequence: review.sourceSequence,
          throughSequence: sourceWatermark,
        })
        .pipe(Stream.runCollect);
      const pair = source.handoffTransfer;
      const stoppedSessions = new Map<
        ProviderSessionId,
        {
          before: OrchestrationV2ProviderSession;
          after: OrchestrationV2ProviderSession;
          sequence: number;
        }
      >();
      // Only the complete, receipt-backed startup stop for this released pair can be replayed for comparison.
      const checkStartupStop = Effect.fn("HandoffTransferAdmission.checkStartupStop")(function* (
        ownerId: ThreadId,
        rows: ReadonlyArray<OrchestrationV2StoredEvent>,
      ) {
        if (rows.length === 0 || pair?.state !== "released") return false;
        const commandId = handoffStartupStopCommand(pair, ownerId);
        if (rows.some((row) => row.commandId !== commandId)) return false;
        const release = yield* receipts.getByCommandId(
          CommandId.make(`handoff-transfer:${requestId}:release`),
        );
        const receipt = yield* receipts.getByCommandId(commandId);
        if (
          Option.isNone(release) ||
          release.value.status !== "accepted" ||
          release.value.threadId !== pair.successorThreadId ||
          release.value.commandType !== "prepared-run.release" ||
          Option.isNone(receipt) ||
          receipt.value.status !== "accepted" ||
          receipt.value.threadId !== ownerId ||
          receipt.value.commandType !== "handoff.transfer.startup-stop" ||
          receipt.value.resultSequence !== rows.at(-1)?.sequence
        )
          return false;
        const committed = yield* events.readByCommandId({ commandId }).pipe(Stream.runCollect);
        if (
          committed.length !== rows.length ||
          committed.some((row, index) => row.sequence !== rows[index]?.sequence)
        )
          return false;
        for (const { event, sequence } of rows) {
          if (
            sequence <= release.value.resultSequence ||
            event.threadId !== ownerId ||
            event.type !== "provider-session.updated" ||
            event.handoffStartupBefore?.status !== "ready" ||
            !sameHandoffSession(
              event.payload,
              stopReadyHandoffSession(event.handoffStartupBefore, event.occurredAt),
            ) ||
            stoppedSessions.has(event.payload.id)
          )
            return false;
          stoppedSessions.set(event.payload.id, {
            before: event.handoffStartupBefore,
            after: event.payload,
            sequence,
          });
        }
        return true;
      });
      const sourceStops =
        pair?.state === "released"
          ? later.filter((row) => row.commandId === handoffStartupStopCommand(pair, sourceId))
          : [];
      if (sourceStops.length && !(yield* checkStartupStop(sourceId, sourceStops)))
        return yield* failed(sourceId, "unrelated-source-event");
      const childSequences = yield* Effect.forEach(review.children, (child) =>
        Effect.gen(function* () {
          const sequence = yield* events.latestSequence({ threadId: child.id });
          if (sequence !== child.sequence) {
            const tail = yield* events
              .read({
                threadId: child.id,
                afterSequence: child.sequence,
                throughSequence: sequence,
              })
              .pipe(Stream.runCollect);
            if (!(yield* checkStartupStop(child.id, tail)))
              return yield* failed(sourceId, "unrelated-child-event");
          }
          return { threadId: child.id, sequence };
        }),
      );
      let recorded = 0,
        acceptedDecisions = 0;
      for (const row of later) {
        let ownReview =
          row.event.type === "runtime-request.updated" &&
          row.event.payload.id === requestId &&
          row.event.payload.responseCapability.type === "handoff" &&
          reviewsEqual(row.event.payload.responseCapability, review);
        if (ownReview && row.event.type === "runtime-request.updated") {
          const receipt =
            row.commandId === null ? Option.none() : yield* receipts.getByCommandId(row.commandId);
          const pending =
            row.event.payload.status === "pending" &&
            row.event.payload.decision === undefined &&
            row.commandId === CommandId.make(requestId);
          const approved =
            row.event.payload.status === "resolved" && row.event.payload.decision === "accept";
          ownReview =
            Option.isSome(receipt) &&
            receipt.value.status === "accepted" &&
            receipt.value.threadId === sourceId &&
            (pending
              ? receipt.value.commandType === "handoff.approval.record" && ++recorded === 1
              : approved &&
                receipt.value.commandType === "runtime-request.respond" &&
                ++acceptedDecisions === 1);
        }
        const ownTransfer =
          row.event.type === "thread.metadata-updated" &&
          row.event.payload.handoffTransfer?.requestId === requestId &&
          row.event.payload.handoffTransfer.generation === generation &&
          (row.commandId === CommandId.make(`handoff-transfer:${requestId}:prepare`) ||
            row.commandId === CommandId.make(`handoff-transfer:${requestId}:release`) ||
            row.commandId === CommandId.make(`handoff-transfer:${requestId}:start`) ||
            row.commandId === CommandId.make(`handoff-transfer:${requestId}:recover:1`) ||
            row.commandId === CommandId.make(`handoff-transfer:${requestId}:recover:2`));
        // Observable checkpoints remain in release evidence; the final watermark fences later events.
        const checkpoint =
          row.event.type === "checkpoint.captured" ||
          row.event.type === "checkpoint-scope.created" ||
          (row.event.type === "turn-item.updated" && row.event.payload.type === "checkpoint") ||
          (row.event.type === "run.updated" && row.event.payload.checkpointId !== null);
        if (!ownReview && !ownTransfer && !checkpoint && !sourceStops.includes(row))
          return yield* failed(sourceId, "unrelated-source-event");
      }
      if (recorded !== 1 || acceptedDecisions !== 1)
        return yield* failed(sourceId, "review-bookkeeping");
      let parkedBootstrapEventId: EventId | undefined;
      if (lostReplacement !== undefined) {
        if (pair?.state !== "released" || !pair.recoveryCount || pair.parkedRecovery !== undefined)
          return yield* failed(sourceId, "no-lost-replacement");
        const recovery = yield* receipts.getByCommandId(
          handoffRecoveryCommand(pair, pair.recoveryCount),
        );
        const claim = yield* receipts.getByCommandId(
          CommandId.make(`handoff-transfer:${pair.requestId}:start`),
        );
        if (
          Option.isNone(recovery) ||
          recovery.value.status !== "accepted" ||
          recovery.value.threadId !== sourceId ||
          recovery.value.commandType !== "handoff.transfer.recover" ||
          Option.exists(claim, (receipt) => receipt.status === "accepted")
        )
          return yield* failed(sourceId, "replacement-receipt");
        const writes = yield* events
          .readByCommandId({ commandId: handoffProviderOpenCommand(pair) })
          .pipe(Stream.runCollect);
        const bootstrap = writes.filter(
          ({ event, sequence }) =>
            event.type === "provider-session.updated" &&
            event.threadId === pair.successorThreadId &&
            event.payload.status === "ready" &&
            stoppedSessions.has(event.payload.id) &&
            sequence > recovery.value.resultSequence &&
            DateTime.toEpochMillis(event.occurredAt) <= Date.parse(lostReplacement.completedAt),
        );
        if (bootstrap.length !== 1) return yield* failed(sourceId, "replacement-bootstrap");
        parkedBootstrapEventId = bootstrap[0]!.event.id;
      }
      const sessionWrites: SessionWriteExpectation[] = [];
      const reviewedSessions = new Map<ProviderSessionId, OrchestrationV2ProviderSession>();
      for (const [id, stopped] of parkedBootstrapEventId === undefined ? stoppedSessions : []) {
        const writes = yield* projections.listHandoffSessionWrites(sourceId, id, stopped.sequence);
        if (writes.length === 0) {
          reviewedSessions.set(id, stopped.after);
        } else {
          const bootstrap = ownProviderStart?.sessionWrite;
          const last = writes.at(-1);
          if (
            pair?.state !== "released" ||
            ownProviderStart?.sessionId !== id ||
            bootstrap?.payload.status !== "ready" ||
            bootstrap.payload.id !== id ||
            last?.eventId !== bootstrap.id ||
            last.type !== "provider-session.updated" ||
            writes.length > 2 ||
            (writes.length === 2 && writes[0]?.type !== "provider-session.attached") ||
            writes.some(
              (row) =>
                row.threadId !== pair.successorThreadId ||
                row.commandId !== handoffProviderOpenCommand(pair),
            )
          )
            return yield* failed(sourceId, "unrelated-provider-session-event");
          reviewedSessions.set(id, bootstrap.payload);
        }
        sessionWrites.push({
          id,
          afterSequence: stopped.sequence,
          throughSequence: writes.at(-1)?.sequence ?? stopped.sequence,
        });
      }
      // Startup only schedules the existing released run. Live owners may not be
      // available until its provider session is opened, so the claim reobserves them.
      if (reobservePhysical) {
        if (Option.isNone(git) || Option.isNone(terminals))
          return yield* failed(sourceId, "physical-owner-service-unavailable");
        const providers = yield* models.getProviders;
        const modelError = agentModelPolicy({
          selection: request.modelSelection,
          provider: providers.find(
            (provider) => provider.instanceId === request.modelSelection.instanceId,
          ),
        });
        if (modelError !== null) return yield* failed(sourceId, "unverified-model-selection");
        const snapshot = yield* queryHandoffReadinessWithReaders(
          sourceId,
          undefined,
          {
            readHandoffRecords: (id, fields, filter) =>
              projections.getThreadRecords(id, fields, filter).pipe(
                Effect.map((records) => {
                  if (stoppedSessions.size === 0 || !("providerSessions" in records))
                    return records;
                  const current =
                    records.providerSessions as ReadonlyArray<OrchestrationV2ProviderSession>;
                  return {
                    ...records,
                    providerSessions: current
                      .map((session) => {
                        const stopped = stoppedSessions.get(session.id);
                        const expected = reviewedSessions.get(session.id);
                        return stopped !== undefined &&
                          expected !== undefined &&
                          sameHandoffSession(session, expected)
                          ? stopped.before
                          : session;
                      })
                      .toSorted(
                        (a, b) =>
                          DateTime.Order(a.updatedAt, b.updatedAt) ||
                          (a.id < b.id ? -1 : a.id === b.id ? 0 : 1),
                      ),
                  };
                }),
                Effect.mapError((cause) => failed(id, String(cause))),
              ),
            readHandoffChildIds: (id) =>
              projections
                .listAppOwnedChildThreadIds(id, true)
                .pipe(Effect.mapError(() => failed(id, "children"))),
            getThreadEventSequence: (id) =>
              events
                .latestSequence({ threadId: id })
                .pipe(Effect.mapError(() => failed(id, "sequence"))),
          },
          requestId,
          ownProviderStart,
          stoppedSessions.size === 0 ? undefined : review.children,
        ).pipe(
          Effect.provideService(Git.GitManager, git.value),
          Effect.provideService(Terminals.TerminalManager, terminals.value),
          Effect.provideService(Sessions.ProviderSessionManagerV2, sessions),
          Effect.provideService(Projects.ProjectStoreV2, projects),
          Effect.provideService(Outbox.EffectOutboxV2, outbox),
          Effect.provideService(Digest.Digest, digest),
        );
        if (
          !snapshot.stable ||
          snapshot.classification !==
            (review.declaration === automaticHandoffDeclaration
              ? "automatically_eligible"
              : "manual_review") ||
          snapshot.releaseEvidence !== review.releaseEvidence ||
          snapshot.after.blockers.length ||
          snapshot.after.unknowns.length ||
          snapshot.after.sourceSequence !== sourceWatermark ||
          snapshot.after.children.some(
            (child) =>
              child.sequence === null ||
              child.records?.thread.lineage.parentThreadId !== sourceId ||
              child.records.thread.lineage.relationshipToParent !== "subagent",
          ) ||
          snapshot.after.childIds?.length !== review.children.length ||
          childSequences.some(
            (child) =>
              !snapshot.after.children.some(
                (current) => current.id === child.threadId && current.sequence === child.sequence,
              ),
          )
        )
          return yield* failed(sourceId, "physical-reobservation");
      }
      const successorSequences: Array<{ threadId: ThreadId; sequence: number }> = [];
      if (pair !== undefined) {
        if (
          pair.requestId !== requestId ||
          pair.generation !== generation ||
          pair.successorThreadId !== request.successorThreadId ||
          pair.state === "cancelled"
        )
          return yield* failed(sourceId, "pair-binding");
        const successorSequence = yield* events.latestSequence({
          threadId: pair.successorThreadId,
        });
        const successor = yield* projections.getThreadRecords(pair.successorThreadId, [
          "runs",
          "messages",
        ]);
        if (
          successor.thread.handoffSourceThreadId !== sourceId ||
          successor.thread.projectId !== (request.target?.projectId ?? request.projectId) ||
          successor.thread.branch !==
            (request.target === undefined ? request.branch : request.target.branch) ||
          successor.thread.worktreePath !==
            (request.target === undefined ? request.worktreePath : null) ||
          !modelSelectionsEqual(successor.thread.modelSelection, request.modelSelection) ||
          successor.thread.runtimeMode !== request.runtimeMode ||
          successor.thread.interactionMode !== request.interactionMode ||
          successor.runs.length !== 1 ||
          successor.messages.length !== 1 ||
          successor.runs[0]?.id !== pair.runId ||
          !modelSelectionsEqual(successor.runs[0].modelSelection, request.modelSelection) ||
          successor.messages[0]?.text !== (yield* encodeHandoff(request.handoff))
        )
          return yield* failed(sourceId, "successor-tuple");
        successorSequences.push({ threadId: pair.successorThreadId, sequence: successorSequence });
      }
      return {
        source,
        review,
        request,
        sessionWrites,
        ...(parkedBootstrapEventId === undefined ? {} : { parkedBootstrapEventId }),
        expectedSequences: [
          ...successorSequences,
          { threadId: sourceId, sequence: sourceWatermark },
          ...childSequences,
        ],
      } satisfies AcceptedHandoff;
    },
    Effect.mapError((cause) =>
      isHandoffTransferError(cause)
        ? cause
        : new HandoffTransferError({ sourceThreadId: "unknown", stage: "observation", cause }),
    ),
  );

  const assertDispatch = (threadId: ThreadId, commandType: string) =>
    assertHandoffDispatch(projections, threadId, commandType);

  const start = Effect.fn("HandoffTransferAdmission.start")(
    function* (threadId: ThreadId, runId: RunId, ownProviderStart?: ProviderStart) {
      const thread = yield* projections.getThread(threadId);
      if (thread.handoffSourceThreadId === undefined) {
        yield* assertDispatch(threadId, "provider-start");
        return;
      }
      const sourceId = thread.handoffSourceThreadId;
      yield* executor.withLock(
        sourceId,
        Effect.gen(function* () {
          const source = yield* projections.getThread(sourceId);
          const pair = source.handoffTransfer;
          if (
            !pair ||
            pair.successorThreadId !== threadId ||
            (pair.state !== "started" && pair.runId !== runId) ||
            !["released", "started"].includes(pair.state) ||
            pair.parkedRecovery !== undefined
          )
            return yield* failed(sourceId, "provider-start-fenced");
          const decisionForLocks = yield* projections.getRuntimeRequest(sourceId, pair.requestId);
          const children =
            decisionForLocks?.responseCapability.type === "handoff"
              ? decisionForLocks.responseCapability.children.map((child) => child.id).toSorted()
              : [];
          const ids = [...new Set([...children, threadId])].filter((id) => id !== sourceId);
          return yield* ids.reduceRight(
            (locked, id) => executor.withLock(id, locked),
            Effect.gen(function* () {
              const commandId = CommandId.make(`handoff-transfer:${pair.requestId}:start`);
              const receipt = yield* receipts.getByCommandId(commandId);
              if (pair.state === "started") {
                if (
                  Option.isNone(receipt) ||
                  receipt.value.status !== "accepted" ||
                  receipt.value.commandType !== "handoff.transfer.start"
                )
                  return yield* failed(sourceId, "start-receipt");
                const decision = yield* projections.getRuntimeRequest(sourceId, pair.requestId);
                if (
                  decision?.status !== "resolved" ||
                  decision.decision !== "accept" ||
                  decision.responseCapability.type !== "handoff" ||
                  decision.responseCapability.generation !== pair.generation ||
                  decision.responseCapability.successorThreadId !== threadId
                )
                  return yield* failed(sourceId, "committed-decision");
                // The claim is durable before the adapter call. A missing provider receipt
                // cannot distinguish a lost acknowledgement from an unsent prompt.
                if (runId === pair.runId)
                  return yield* failed(sourceId, "initial-start-already-claimed");
                return;
              }
              const project =
                source.worktreePath === null
                  ? yield* projects.get(source.projectId)
                  : Option.none();
              const checkout = source.worktreePath ?? Option.getOrUndefined(project)?.workspaceRoot;
              if (checkout === undefined) return yield* failed(sourceId, "checkout-unavailable");
              const admitted = yield* executor.withHandoffCheckout(
                [checkout],
                "claim",
                Effect.gen(function* () {
                  const accepted = yield* inspect(
                    sourceId,
                    pair.requestId,
                    pair.generation,
                    ownProviderStart,
                  );
                  const now = yield* DateTime.now;
                  const commit = sink.commitCommand({
                    commandId,
                    threadId: sourceId,
                    commandType: "handoff.transfer.start",
                    acceptedAt: now,
                    expectedHandoff: { review: accepted.review, request: accepted.request },
                    expectedThreadSequences: accepted.expectedSequences,
                    events: [
                      {
                        id: EventId.make(`${commandId}:ownership`),
                        type: "thread.metadata-updated",
                        threadId: sourceId,
                        occurredAt: now,
                        payload: { ...source, handoffTransfer: { ...pair, state: "started" } },
                      },
                    ],
                    effects: [],
                  });
                  const claim = yield* accepted.sessionWrites.length === 0
                    ? commit
                    : sink.withProviderBatch(
                        Effect.gen(function* () {
                          for (const expected of accepted.sessionWrites) {
                            const rows = yield* projections.listHandoffSessionWrites(
                              sourceId,
                              expected.id,
                              expected.afterSequence,
                            );
                            if (
                              (rows.at(-1)?.sequence ?? expected.afterSequence) !==
                              expected.throughSequence
                            )
                              return yield* failed(
                                sourceId,
                                "provider-session-changed-before-claim",
                              );
                          }
                          return yield* commit;
                        }),
                      );
                  if (!claim.committed)
                    return yield* failed(sourceId, "initial-start-already-claimed");
                }),
              );
              if (Option.isNone(admitted))
                return yield* failed(sourceId, "checkout-terminal-mutation");
            }),
          );
        }),
      );
    },
    Effect.mapError((cause) =>
      isHandoffTransferError(cause)
        ? cause
        : new HandoffTransferError({ sourceThreadId: "unknown", stage: "start", cause }),
    ),
  );
  return HandoffTransferAdmission.of({
    canForceFollowup: Effect.fn("HandoffTransferAdmission.canForceFollowup")(
      function* (sourceId) {
        if (
          Option.isNone(terminals) ||
          Option.isSome(yield* outbox.get(`core-handoff:${sourceId}`))
        )
          return false;
        // This is another turn on the same owner, not a transfer: dirty files do not prevent it.
        const observe = Effect.fnUntraced(function* () {
          const childIds = yield* projections.listAppOwnedChildThreadIds(sourceId, true);
          const owners = yield* Effect.forEach([sourceId, ...childIds], (id) =>
            projections.getThreadRecords(id, [
              "runs",
              "runtimeRequests",
              "subagents",
              "nodes",
              "providerTurns",
              "providerThreads",
              "turnItems",
            ]),
          );
          const source = owners[0]!;
          if (
            source.thread.lineage.relationshipToParent === "subagent" ||
            source.thread.lineage.sideChat === true ||
            source.thread.handoffTransfer !== undefined
          )
            return null;
          const project = yield* projects.get(source.thread.projectId);
          const cwd =
            source.thread.worktreePath ??
            (Option.isSome(project) ? project.value.workspaceRoot : null);
          if (cwd === null) return null;
          const active = new Set([
            "preparing",
            "pending",
            "queued",
            "starting",
            "running",
            "waiting",
          ]);
          const observations = [];
          for (const owner of owners) {
            if (
              owner.thread.archivedAt !== null ||
              owner.thread.deletedAt !== null ||
              owner.thread.linkOrigin !== undefined ||
              owner.thread.agentExecutionIntent?.restrictedTools !== undefined ||
              owner.runs.some((run) => active.has(run.status)) ||
              owner.runtimeRequests.some((request) => request.status === "pending") ||
              owner.subagents.some((task) => active.has(task.status)) ||
              owner.nodes.some((node) => active.has(node.status)) ||
              owner.providerTurns.some((turn) => active.has(turn.status)) ||
              owner.turnItems.some(
                (item) => item.type === "command_execution" && active.has(item.status),
              )
            )
              return null;
            for (const provider of owner.providerThreads) {
              if (
                provider.status !== "idle" ||
                !Array.isArray(provider.pendingBackgroundTasks) ||
                provider.pendingBackgroundTasks.length > 0 ||
                provider.providerSessionId === null
              )
                return null;
              const entry = yield* sessions.observeHandoffSession(provider.providerSessionId);
              if (Option.isNone(entry) || entry.value.busyTurns.length > 0) return null;
              const runtime = entry.value.runtime;
              if (
                runtime.handoffReadinessCoverage?.scope !== "all-app-owned-work" ||
                !runtime.handoffReadinessCoverage.nativeSubagents ||
                !runtime.handoffReadinessCoverage.detachedTasks ||
                runtime.hasPendingBackgroundWork === undefined ||
                runtime.hasPendingBackgroundWorkForThread === undefined
              )
                return null;
              if (
                (yield* runtime.hasPendingBackgroundWork) ||
                (yield* runtime.hasPendingBackgroundWorkForThread(provider, {
                  includeSubagents: true,
                }))
              )
                return null;
              observations.push({
                id: provider.id,
                session: provider.providerSessionId,
                generation: entry.value.idleGeneration,
              });
            }
          }
          const terminalRows = yield* terminals.value.observeHandoff([sourceId, ...childIds], cwd);
          if (
            !Array.isArray(terminalRows) ||
            terminalRows.some(
              (terminal) =>
                terminal.status === "starting" ||
                terminal.running !== false ||
                terminal.cachedRunning ||
                terminal.error !== null,
            )
          )
            return null;
          return yield* encodeFollowupObservation({
            owners,
            observations,
            terminalRows,
          });
        });
        const before = yield* observe();
        const after = yield* observe();
        return before !== null && before === after;
      },
      Effect.mapError(
        (cause) =>
          new HandoffTransferError({
            sourceThreadId: "unknown",
            stage: "forced-followup-observation",
            cause,
          }),
      ),
    ),
    inspect,
    inspectRecovery: Effect.fn("HandoffTransferAdmission.inspectRecovery")(
      (sourceId, requestId, generation, lostReplacement) =>
        inspect(sourceId, requestId, generation, undefined, false, lostReplacement),
    ),
    assertDispatch,
    start,
  });
});
export const layer = Layer.effect(HandoffTransferAdmission, make);
