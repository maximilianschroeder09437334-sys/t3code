import { ThreadId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
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

const affectsParkedHandoff = (event: OrchestrationV2DomainEvent) =>
  event.type.startsWith("thread.") ||
  event.type === "run.created" ||
  event.type === "run.updated" ||
  event.type === "runtime-request.updated" ||
  event.type.startsWith("provider-session.") ||
  event.type.startsWith("provider-thread.") ||
  event.type === "message.updated";

export class HandoffParkedReconciler extends Context.Service<
  HandoffParkedReconciler,
  {
    /** Explicit observational refresh also covers external workspace-only changes. */
    readonly refresh: (threadId: ThreadId) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/HandoffParkedReconciler") {}

const make = Effect.gen(function* () {
  const outbox = yield* Outbox.EffectOutboxV2;
  const projections = yield* Projections.ProjectionStoreV2;
  const producer = yield* Producer.HandoffApprovalProducer;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sessions = yield* Sessions.ProviderSessionManagerV2;
  const terminals = yield* Effect.serviceOption(Terminals.TerminalManager);
  const pending = new Set<ThreadId>();
  const queue = yield* Queue.bounded<ThreadId>(64);
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
  const enqueue = Effect.fn("HandoffParkedReconciler.enqueue")(function* (id: ThreadId) {
    if (pending.has(id)) return;
    pending.add(id);
    yield* Queue.offer(queue, id);
  });
  const refresh = Effect.fn("HandoffParkedReconciler.refresh")(
    function* (id: ThreadId) {
      // A descendant's committed lifecycle change can unblock its root owner.
      let current: ThreadId | null = id;
      for (let depth = 0; current !== null && depth < 32; depth++) {
        const rows = yield* outbox.listParkedHandoffs({ threadId: current });
        if (rows.some(eligible)) yield* enqueue(current);
        const owner: ThreadId = current;
        const shell = yield* projections.getThreadShell(owner);
        current =
          shell === null ? null : (yield* projections.getThread(owner)).lineage.parentThreadId;
      }
    },
    Effect.catchCause((cause) => Effect.logWarning("handoff.refresh-unavailable", { cause })),
  );
  yield* forkParked(
    Effect.gen(function* () {
      // Acquire subscriptions before scanning; queued transitions cannot fall into a startup gap.
      const events = yield* orchestrator.streamDomainEvents.pipe(
        Stream.filter(affectsParkedHandoff),
        Stream.toQueue({ capacity: 64 }),
      );
      const readiness =
        sessions.streamHandoffReadiness === undefined
          ? undefined
          : yield* sessions.streamHandoffReadiness.pipe(Stream.toQueue({ capacity: 64 }));
      if (Option.isSome(terminals)) {
        yield* Effect.acquireRelease(
          terminals.value.subscribeMetadata((event) =>
            event.type === "snapshot"
              ? Effect.void
              : refresh(
                  ThreadId.make(event.type === "remove" ? event.threadId : event.terminal.threadId),
                ),
          ),
          (stop) => Effect.sync(stop),
        );
      }
      yield* forkParked(
        Effect.gen(function* () {
          let after: string | undefined;
          while (true) {
            const rows = yield* outbox.listParkedHandoffs(after === undefined ? {} : { after });
            for (const row of rows) if (eligible(row)) yield* enqueue(row.threadId);
            if (rows.length < 64) break;
            after = rows.at(-1)!.id;
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("handoff.startup-scan-unavailable", { cause }),
          ),
        ),
      );
      yield* forkParked(
        Effect.forever(Queue.take(events).pipe(Effect.flatMap((event) => refresh(event.threadId)))),
      );
      if (readiness !== undefined)
        yield* forkParked(Effect.forever(Queue.take(readiness).pipe(Effect.flatMap(refresh))));
      yield* forkParked(
        Effect.forever(
          Effect.gen(function* () {
            const id = yield* Queue.take(queue);
            // Removing before observation allows exactly one queued follow-up while this evaluation runs.
            pending.delete(id);
            const rows = yield* outbox.listParkedHandoffs({ threadId: id });
            if (!rows.some(eligible)) return;
            yield* producer.requestIfReady(id).pipe(Effect.catchCause(() => Effect.void));
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("handoff.reconcile-unavailable", { cause }),
            ),
          ),
        ),
      );
    }),
  );
  return { refresh };
});
export const layer = Layer.effect(HandoffParkedReconciler, make);
