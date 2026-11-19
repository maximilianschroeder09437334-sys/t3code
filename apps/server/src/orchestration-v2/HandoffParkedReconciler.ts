import * as Git from "../git/GitManager.ts";
import * as Projects from "./ProjectStore.ts";
import { ThreadId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Settings from "../serverSettings.ts";
import { ProviderTurnStartModels } from "./ProviderTurnStartService.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Terminals from "../terminal/Manager.ts";
import { forkParked } from "../serverActivation.ts";
import * as Outbox from "./EffectOutbox.ts";
import * as Projections from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as Sessions from "./ProviderSessionManager.ts";
import * as Producer from "./HandoffApprovalProducer.ts";
import { decodeParkReason } from "./HandoffParkReason.ts";

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const affectsParkedHandoff = (event: OrchestrationV2DomainEvent) =>
  event.type.startsWith("thread.") ||
  event.type === "run.created" ||
  event.type === "run.updated" ||
  event.type === "runtime-request.updated" ||
  event.type.startsWith("provider-session.") ||
  event.type.startsWith("provider-thread.") ||
  event.type === "message.updated" ||
  event.type === "checkpoint.captured";

export class HandoffParkedReconciler extends Context.Service<
  HandoffParkedReconciler,
  {
    /** Explicit observational refresh also covers external workspace-only changes. */
    readonly refresh: (threadId: ThreadId, generation?: string) => Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/HandoffParkedReconciler") {}

const make = Effect.gen(function* () {
  const outbox = yield* Outbox.EffectOutboxV2;
  const projections = yield* Projections.ProjectionStoreV2;
  const producer = yield* Producer.HandoffApprovalProducer;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sessions = yield* Sessions.ProviderSessionManagerV2;
  const terminals = yield* Effect.serviceOption(Terminals.TerminalManager);
  const git = yield* Effect.serviceOption(Git.GitManager);
  const projects = yield* Effect.serviceOption(Projects.ProjectStoreV2);
  const models = yield* ProviderTurnStartModels;
  const settings = yield* Effect.serviceOption(Settings.ServerSettingsService);
  const states = new Map<
    ThreadId,
    { inputs: Map<string, string>; revision: number; pending: boolean }
  >();
  const startup = yield* Deferred.make<void>();
  const queue = yield* Queue.bounded<ThreadId | Deferred.Deferred<void>>(64);
  const drain = Effect.gen(function* () {
    yield* Deferred.await(startup);
    const done = yield* Deferred.make<void>();
    yield* Queue.offer(queue, done);
    yield* Deferred.await(done);
  });
  const eligible = (row: Outbox.OrchestrationEffectV2) => {
    const reason = decodeParkReason(row.lastError);
    return (
      row.id === `core-handoff:${row.threadId}` &&
      row.request.type === "thread.handoff" &&
      Option.isSome(reason) &&
      reason.value.retryable &&
      reason.value.sourceThreadId === row.threadId &&
      reason.value.requestId === `core-handoff:${row.threadId}` &&
      reason.value.sourceRunId === (row.request.sourceRunId ?? null)
    );
  };
  const sessionGeneration = Effect.fn("HandoffParkedReconciler.sessionGeneration")(
    function* (id: ThreadId) {
      const thread = yield* projections.getThreadRecords(id, ["providerThreads"]);
      const entries = yield* Effect.forEach(
        thread.providerThreads.filter((provider) => provider.providerSessionId !== null),
        (provider) =>
          sessions
            .observeHandoffSession(provider.providerSessionId!)
            .pipe(
              Effect.map((entry) => [
                provider.providerSessionId,
                Option.isSome(entry) ? [entry.value.idleGeneration, entry.value.busyTurns] : null,
              ]),
            ),
      );
      return yield* encode(entries);
    },
    Effect.catchCause(() => Effect.succeed("unknown")),
  );
  const domainGeneration = Effect.fn("HandoffParkedReconciler.domainGeneration")(
    function* (id: ThreadId) {
      const children = yield* orchestrator.listAppOwnedChildThreadIds(id);
      return yield* encode(
        yield* Effect.forEach([id, ...children].sort(), (owner) =>
          orchestrator
            .getThreadEventSequence(owner)
            .pipe(Effect.map((sequence) => [owner, sequence])),
        ),
      );
    },
    Effect.catchCause(() => Effect.succeed("unknown")),
  );
  const enqueue = Effect.fn("HandoffParkedReconciler.enqueue")(function* (
    id: ThreadId,
    channel: string,
    identity: string,
  ) {
    let state = states.get(id);
    const fresh = state === undefined;
    if (state === undefined) {
      state = {
        inputs: new Map<string, string>(),
        revision: 0,
        pending: false,
      };
      if (channel === "startup")
        state.inputs.set(
          "explicit",
          decodeParkReason(identity).pipe(
            Option.map((reason) => reason.generation ?? ""),
            Option.getOrElse(() => ""),
          ),
        );
      states.set(id, state);
      const domain = yield* domainGeneration(id);
      if (!state.inputs.has("domain")) state.inputs.set("domain", domain);
      const generation = yield* sessionGeneration(id);
      if (!state.inputs.has("session")) state.inputs.set("session", generation);
    }
    if (!fresh && state.inputs.get(channel) === identity) return;
    // Retain only a bounded notification window for each current candidate.
    if (state.inputs.size >= 64) {
      const oldest = [...state.inputs.keys()].find((key) => key.startsWith("terminal:"));
      if (oldest !== undefined) state.inputs.delete(oldest);
    }
    state.inputs.set(channel, identity);
    state.revision++;
    if (state.pending) return;
    state.pending = true;
    yield* Queue.offer(queue, id);
  });
  const workspaceGeneration = Effect.fn("HandoffParkedReconciler.workspaceGeneration")(
    function* (id: ThreadId) {
      if (Option.isNone(git)) return "unknown";
      const records = yield* projections.getThreadRecords(id, ["checkpoints"]);
      let cwd = records.thread.worktreePath;
      if (cwd === null && Option.isSome(projects)) {
        const project = yield* projects.value.get(records.thread.projectId);
        if (Option.isSome(project)) cwd = project.value.workspaceRoot;
      }
      if (cwd === null) return "unknown";
      const checkpoint = records.checkpoints
        .filter((item) => item.status === "ready")
        .toSorted((a, b) => b.ordinalWithinScope - a.ordinalWithinScope)[0];
      return yield* encode(yield* git.value.observeHandoffWorkspace(cwd, checkpoint?.ref ?? null));
    },
    Effect.catchCause(() => Effect.succeed("unknown")),
  );
  const refreshInput = Effect.fn("HandoffParkedReconciler.refreshInput")(
    function* (id: ThreadId, channel: string, identity: string) {
      let current: ThreadId | null = id;
      for (let depth = 0; current !== null && depth < 32; depth++) {
        const rows = yield* outbox.listParkedHandoffs({ threadId: current });
        if (rows.some(eligible))
          yield* enqueue(
            current,
            channel,
            channel === "domain" ? yield* domainGeneration(current) : identity,
          );
        else states.delete(current);
        const owner: ThreadId = current;
        const shell = yield* projections.getThreadShell(owner);
        current =
          shell === null ? null : (yield* projections.getThread(owner)).lineage.parentThreadId;
      }
    },
    Effect.catchCause((cause) => Effect.logWarning("handoff.refresh-unavailable", { cause })),
  );
  const refresh = Effect.fn("HandoffParkedReconciler.refresh")(function* (
    id: ThreadId,
    generation?: string,
  ) {
    yield* refreshInput(id, "explicit", generation ?? (yield* workspaceGeneration(id)));
  });
  const refreshWorkspace = Effect.fn("HandoffParkedReconciler.refreshWorkspace")(
    function* (root: string, channel: string, identity: string) {
      let after: string | undefined;
      while (true) {
        const rows = yield* outbox.listParkedHandoffs({
          workspaceRoot: root,
          ...(after === undefined ? {} : { after }),
        });
        for (const row of rows) if (eligible(row)) yield* enqueue(row.threadId, channel, identity);
        if (rows.length < 64) break;
        after = rows.at(-1)!.id;
      }
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("handoff.workspace-refresh-unavailable", { cause }),
    ),
  );
  yield* forkParked(
    Effect.gen(function* () {
      // Acquire subscriptions before scanning; queued transitions cannot fall into a startup gap.
      const initialProviders = yield* models.getProviders;
      const initialSignatures = yield* Effect.forEach(initialProviders, (provider) =>
        encode(provider).pipe(Effect.map((signature) => [provider.instanceId, signature] as const)),
      );
      const events = yield* orchestrator.streamDomainEvents.pipe(
        Stream.filter(affectsParkedHandoff),
        Stream.toQueue({ capacity: 64 }),
      );
      const providers =
        models.streamChanges === undefined
          ? undefined
          : yield* models.streamChanges.pipe(Stream.toQueue({ capacity: 64 }));
      const readiness =
        sessions.streamHandoffReadiness === undefined
          ? undefined
          : yield* sessions.streamHandoffReadiness.pipe(Stream.toQueue({ capacity: 64 }));
      if (Option.isSome(terminals)) {
        const pathsByTerminal = new Map<string, ReadonlyArray<string>>();
        const key = (threadId: string, terminalId: string) =>
          JSON.stringify([threadId, terminalId]);
        yield* Effect.acquireRelease(
          terminals.value.subscribeMetadata((event) =>
            Effect.gen(function* () {
              if (event.type === "snapshot") {
                pathsByTerminal.clear();
                for (const terminal of event.terminals)
                  pathsByTerminal.set(key(terminal.threadId, terminal.terminalId), [
                    terminal.cwd,
                    ...(terminal.worktreePath === null ? [] : [terminal.worktreePath]),
                  ]);
                return;
              }
              const threadId = event.type === "remove" ? event.threadId : event.terminal.threadId;
              const terminalId =
                event.type === "remove" ? event.terminalId : event.terminal.terminalId;
              const identity = key(threadId, terminalId);
              const previous = pathsByTerminal.get(identity) ?? [];
              const next =
                event.type === "remove"
                  ? []
                  : [
                      event.terminal.cwd,
                      ...(event.terminal.worktreePath === null
                        ? []
                        : [event.terminal.worktreePath]),
                    ];
              if (event.type === "remove") pathsByTerminal.delete(identity);
              else pathsByTerminal.set(identity, next);
              const signature = yield* encode(
                event.type === "remove"
                  ? event
                  : {
                      ...event,
                      terminal: { ...event.terminal, updatedAt: undefined, label: undefined },
                    },
              ).pipe(Effect.orDie);
              yield* refreshInput(ThreadId.make(threadId), "terminal:" + identity, signature);
              for (const root of new Set([...previous, ...next]))
                yield* refreshWorkspace(root, "terminal:" + identity, signature);
            }),
          ),
          (stop) => Effect.sync(stop),
        );
      }
      yield* forkParked(
        Effect.gen(function* () {
          let after: string | undefined;
          while (true) {
            const rows = yield* outbox.listParkedHandoffs(after === undefined ? {} : { after });
            for (const row of rows)
              if (eligible(row)) yield* enqueue(row.threadId, "startup", row.lastError ?? "");
            if (rows.length < 64) break;
            after = rows.at(-1)!.id;
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("handoff.startup-scan-unavailable", { cause }),
          ),
          Effect.ensuring(Deferred.succeed(startup, undefined)),
        ),
      );
      yield* forkParked(
        Effect.forever(
          Queue.take(events).pipe(
            Effect.flatMap((event) => refreshInput(event.threadId, "domain", String(event.id))),
          ),
        ),
      );
      if (readiness !== undefined)
        yield* forkParked(
          Effect.forever(
            Queue.take(readiness).pipe(
              Effect.flatMap((id) =>
                sessionGeneration(id).pipe(
                  Effect.flatMap((generation) => refreshInput(id, "session", generation)),
                ),
              ),
            ),
          ),
        );
      if (providers !== undefined)
        yield* forkParked(
          Effect.gen(function* () {
            let previous = new Map(initialSignatures);
            while (true) {
              const snapshot = yield* Queue.take(providers);
              yield* Effect.gen(function* () {
                const next = new Map(
                  yield* Effect.forEach(snapshot, (provider) =>
                    encode(provider).pipe(
                      Effect.map((signature) => [provider.instanceId, signature] as const),
                    ),
                  ),
                );
                const changed = new Set(
                  [...previous.keys(), ...next.keys()].filter(
                    (id) => previous.get(id) !== next.get(id),
                  ),
                );
                if (changed.size === 0) return;
                const policy = Option.isSome(settings)
                  ? (yield* settings.value.getSettings).rootOwnerUsageLimitFailover
                  : undefined;
                let after: string | undefined;
                while (true) {
                  const rows = yield* outbox.listParkedHandoffs(
                    after === undefined ? {} : { after },
                  );
                  for (const row of rows) {
                    if (!eligible(row) || row.request.type !== "thread.handoff") continue;
                    const source = yield* projections.getThread(row.threadId);
                    const bindings = [
                      source.modelSelection.instanceId,
                      row.request.modelSelection.instanceId,
                      row.request.intent?.destinationSelection.instanceId,
                      row.request.intent?.sourceSelection.instanceId,
                      ...(policy?.enabled &&
                      source.modelSelection.instanceId === policy.source.selection.instanceId
                        ? [policy.destination.selection.instanceId]
                        : []),
                    ];
                    const relevant = bindings.filter((id) => id !== undefined && changed.has(id));
                    if (relevant.length > 0)
                      yield* enqueue(
                        row.threadId,
                        "registry",
                        yield* encode(
                          bindings.map((id) => (id === undefined ? null : [id, next.get(id)])),
                        ),
                      );
                  }
                  if (rows.length < 64) break;
                  after = rows.at(-1)!.id;
                }
                previous = next;
              }).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("handoff.registry-refresh-unavailable", { cause }),
                ),
              );
            }
          }),
        );
      yield* forkParked(
        Effect.forever(
          Effect.gen(function* () {
            const id = yield* Queue.take(queue);
            if (typeof id !== "string") {
              yield* Deferred.succeed(id, undefined);
              return;
            }
            const state = states.get(id);
            if (state === undefined) return;
            yield* Effect.gen(function* () {
              while (true) {
                const revision = state.revision;
                const rows = yield* outbox.listParkedHandoffs({ threadId: id });
                if (!rows.some(eligible)) {
                  states.delete(id);
                  return;
                }
                const result = yield* producer.requestIfReady(id).pipe(Effect.result);
                if (result._tag === "Success") {
                  states.delete(id);
                  return;
                }
                if (state.revision === revision) {
                  state.pending = false;
                  return;
                }
              }
            }).pipe(
              Effect.catchCause((cause) => {
                states.delete(id);
                return Effect.logWarning("handoff.reconcile-unavailable", { cause });
              }),
            );
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("handoff.reconcile-unavailable", { cause }),
            ),
          ),
        ),
      );
    }),
  );
  return { refresh, drain };
});
export const layer = Layer.effect(HandoffParkedReconciler, make);
