import { assert, it } from "@effect/vitest";
import { ThreadId, type HandoffRequest, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Outbox from "./EffectOutbox.ts";
import * as Projections from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as Producer from "./HandoffApprovalProducer.ts";
import * as Sessions from "./ProviderSessionManager.ts";
import * as Reconciler from "./HandoffParkedReconciler.ts";
import { encodeParkReason } from "./HandoffParkReason.ts";

it.effect(
  "parked reconciliation subscribes before startup, coalesces concurrent wakes and ignores legacy rows",
  () =>
    Effect.gen(function* () {
      const source = ThreadId.make("parked-root");
      const legacy = ThreadId.make("legacy-root");
      const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      const readiness = yield* Queue.unbounded<ThreadId>();
      const refreshes = yield* Queue.unbounded<void>();
      const evaluated = yield* Queue.unbounded<ThreadId>();
      const release = yield* Deferred.make<void>();
      let count = 0;
      const request = {
        type: "thread.handoff",
        sourceThreadId: source,
        sourceRunId: "failed-run",
      } as HandoffRequest;
      const row = {
        id: `core-handoff:${source}`,
        threadId: source,
        request,
        status: "failed",
        lastError: encodeParkReason(request, {
          category: "unknown",
          generation: "unknown-generation",
          retryable: true,
          detail: "Provider coverage unknown",
        }),
      } as Outbox.OrchestrationEffectV2;
      const old = {
        ...row,
        id: `core-handoff:${legacy}`,
        threadId: legacy,
        request: { ...request, sourceThreadId: legacy },
        lastError: "HandoffParked: old generic error",
      };
      const owners = Layer.mergeAll(
        Layer.mock(Outbox.EffectOutboxV2)({
          listParkedHandoffs: (input) =>
            Effect.gen(function* () {
              if (input.threadId !== undefined) yield* Queue.offer(refreshes, undefined);
              return input.after !== undefined
                ? []
                : input.threadId === undefined
                  ? [old, row]
                  : input.threadId === legacy
                    ? [old]
                    : [row];
            }),
        }),
        Layer.mock(Projections.ProjectionStoreV2)({
          getThreadShell: () => Effect.succeed(null),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.fromQueue(events) }),
        Layer.mock(Sessions.ProviderSessionManagerV2)({
          streamHandoffReadiness: Stream.fromQueue(readiness),
        }),
        Layer.succeed(Producer.HandoffApprovalProducer, {
          requestIfReady: (id) =>
            Effect.gen(function* () {
              count++;
              yield* Queue.offer(evaluated, id);
              if (count === 1) yield* Deferred.await(release);
            }),
        }),
      );
      yield* Effect.gen(function* () {
        assert.equal(yield* Queue.take(evaluated), source);
        yield* Queue.clear(refreshes);
        for (let index = 0; index < 8; index++)
          yield* Queue.offer(events, {
            id: "same-committed-event",
            type: "provider-thread.updated",
            threadId: source,
          } as OrchestrationV2DomainEvent);
        yield* Queue.offer(readiness, source);
        for (let index = 0; index < 9; index++) yield* Queue.take(refreshes);
        assert.equal(count, 1);
        yield* Deferred.succeed(release, undefined);
        assert.equal(yield* Queue.take(evaluated), source);
        assert.equal(count, 2);
        yield* (yield* Reconciler.HandoffParkedReconciler).refresh(legacy);
        assert.equal(count, 2);
      }).pipe(Effect.provide(Reconciler.layer.pipe(Layer.provide(owners))));
    }).pipe(Effect.scoped),
);
