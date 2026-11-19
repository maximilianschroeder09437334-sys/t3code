import * as Git from "../git/GitManager.ts";
import * as Terminals from "../terminal/Manager.ts";
import type { TerminalMetadataStreamEvent } from "@t3tools/contracts";
import { ProviderTurnStartModels } from "./ProviderTurnStartService.ts";
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
  type HandoffRequest,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
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
import { HandoffParked } from "./CoreHandoff.ts";
import { encodeParkReason } from "./HandoffParkReason.ts";

it.effect(
  "bounds paged startup, deduplicates generations during and after flight, and cleans removed candidates",
  () =>
    Effect.gen(function* () {
      const ids = Array.from({ length: 130 }, (_, i) =>
        ThreadId.make(`park-${String(i).padStart(3, "0")}`),
      );
      const rows = ids.map((id) => {
        const request = {
          type: "thread.handoff",
          sourceThreadId: id,
          sourceRunId: "failed-run",
          modelSelection: { instanceId: id === ids[0] ? "a" : "b", model: "inert" },
        } as HandoffRequest;
        return {
          id: `core-handoff:${id}`,
          threadId: id,
          request,
          status: "failed",
          lastError: encodeParkReason(request, {
            category: "unknown",
            generation: "g0",
            retryable: true,
            detail: "unknown",
          }),
        } as Outbox.OrchestrationEffectV2;
      });
      const a = ProviderInstanceId.make("a"),
        b = ProviderInstanceId.make("b");
      const initial: ReadonlyArray<ServerProvider> = [a, b].map((instanceId) => ({
        instanceId,
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        installed: true,
        status: "ready",
        checkedAt: "1970-01-01T00:00:00.000Z",
        auth: { status: "authenticated" },
        availability: "unavailable",
        models: [],
        version: null,
        slashCommands: [],
        skills: [],
      }));
      const changes = yield* Queue.unbounded<ReadonlyArray<ServerProvider>>();
      const registryReads = yield* Queue.unbounded<void>();
      const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      const readiness = yield* Queue.unbounded<ThreadId>();
      const handled = yield* Queue.unbounded<void>();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const counts = new Map<ThreadId, number>();
      const active = new Set(ids);
      let concurrent = 0,
        maxConcurrent = 0,
        pages = 0;
      let physicalGeneration = 0;
      let eventGeneration = 0;
      let workspaceGeneration = 0;
      const owners = Layer.mergeAll(
        Layer.mock(Git.GitManager)({
          observeHandoffWorkspace: () =>
            Effect.succeed({ head: String(workspaceGeneration) } as never),
        }),
        Layer.succeed(ProviderTurnStartModels, {
          getProviders: Effect.succeed(initial),
          streamChanges: Stream.fromQueue(changes),
        }),
        Layer.mock(Outbox.EffectOutboxV2)({
          listParkedHandoffs: (input) =>
            Effect.sync(() => {
              if (input.threadId !== undefined)
                return rows.filter((r) => r.threadId === input.threadId && active.has(r.threadId));
              pages++;
              return rows
                .filter(
                  (r) =>
                    active.has(r.threadId) && (input.after === undefined || r.id > input.after),
                )
                .slice(0, 64);
            }),
        }),
        Layer.mock(Projections.ProjectionStoreV2)({
          getThread: (id) =>
            Effect.gen(function* () {
              if (id === ids.at(-1)) yield* Queue.offer(registryReads, undefined);
              return { modelSelection: { instanceId: id === ids[0] ? a : b } } as never;
            }),
          getThreadRecords: () =>
            Effect.succeed({
              thread: { worktreePath: "/shared" },
              checkpoints: [],
              providerThreads: [{ providerSessionId: "session" }],
            } as never),
          getThreadShell: () => Queue.offer(handled, undefined).pipe(Effect.as(null)),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamDomainEvents: Stream.fromQueue(events),
          listAppOwnedChildThreadIds: () => Effect.succeed([]),
          getThreadEventSequence: () => Effect.succeed(eventGeneration),
        }),
        Layer.mock(Sessions.ProviderSessionManagerV2)({
          streamHandoffReadiness: Stream.fromQueue(readiness),
          observeHandoffSession: () =>
            Effect.succeed({
              _tag: "Some",
              value: { idleGeneration: physicalGeneration, busyTurns: [] },
            } as never),
        }),
        Layer.succeed(Producer.HandoffApprovalProducer, {
          requestIfReady: (id) =>
            Effect.gen(function* () {
              concurrent++;
              maxConcurrent = Math.max(maxConcurrent, concurrent);
              counts.set(id, (counts.get(id) ?? 0) + 1);
              if (id === ids[0] && counts.get(id) === 1) {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }
              concurrent--;
              return yield* new HandoffParked({
                message: "unknown",
                category: "unknown",
                generation: "g0",
              });
            }),
        }),
      );
      yield* Effect.gen(function* () {
        const reconciler = yield* Reconciler.HandoffParkedReconciler;
        yield* Deferred.await(entered);
        const event = {
          id: "same-event",
          type: "checkpoint.captured",
          threadId: ids[0],
        } as OrchestrationV2DomainEvent;
        for (let i = 0; i < 8; i++) yield* Queue.offer(events, event);
        for (let i = 0; i < 8; i++) yield* Queue.take(handled);
        yield* reconciler.refresh(ids[0]!, "g0");
        assert.equal(
          counts.get(ids[0]!),
          1,
          "unchanged committed notification does not schedule a follow-up",
        );
        eventGeneration++;
        yield* Queue.offer(events, {
          ...event,
          id: "changed-checkpoint",
        } as OrchestrationV2DomainEvent);
        yield* Queue.take(handled);
        const coveredA = [{ ...initial[0]!, availability: "available" as const }, initial[1]!];
        yield* Queue.offer(changes, coveredA);
        yield* Queue.take(registryReads);
        yield* reconciler.refresh(ids[0]!, "g0");
        assert.equal(counts.get(ids[0]!), 1);
        yield* Deferred.succeed(release, undefined);
        yield* reconciler.drain;
        assert.equal(
          counts.get(ids[0]!),
          2,
          "one changed committed generation follows the suspended observation",
        );
        assert.equal(counts.size, 130);
        assert.equal(
          pages,
          6,
          "startup and one affected-provider traversal use three keyset pages each",
        );
        assert.equal(maxConcurrent, 1);
        for (let i = 0; i < 8; i++) yield* Queue.offer(events, event);
        for (let i = 0; i < 8; i++) yield* Queue.take(handled);
        yield* reconciler.refresh(ids[0]!, "g0");
        yield* reconciler.drain;
        assert.equal(counts.get(ids[0]!), 2, "unchanged inputs stay idle after drain");
        yield* Queue.clear(handled);
        for (let i = 0; i < 8; i++) yield* Queue.offer(readiness, ids[0]!);
        for (let i = 0; i < 8; i++) yield* Queue.take(handled);
        yield* reconciler.drain;
        assert.equal(counts.get(ids[0]!), 2, "unchanged physical session notifications are idle");
        yield* Queue.offer(changes, coveredA);
        yield* Queue.offer(changes, coveredA);
        const coveredB = [coveredA[0]!, { ...initial[1]!, availability: "available" as const }];
        yield* Queue.offer(changes, coveredB);
        yield* Queue.take(registryReads);
        yield* reconciler.drain;
        assert.equal(
          counts.get(ids[0]!),
          2,
          "unchanged registry emissions and unrelated bindings stay idle",
        );
        assert.equal(counts.get(ids[1]!), 2, "changed provider wakes its affected candidates");
        physicalGeneration++;
        for (let i = 0; i < 8; i++) yield* Queue.offer(readiness, ids[0]!);
        for (let i = 0; i < 8; i++) yield* Queue.take(handled);
        yield* reconciler.drain;
        assert.equal(counts.get(ids[0]!), 3, "actual physical session generation wakes once");
        yield* reconciler.refresh(ids[0]!, "g1");
        yield* reconciler.drain;
        assert.equal(counts.get(ids[0]!), 4);
        active.delete(ids[0]!);
        yield* reconciler.refresh(ids[0]!, "g1");
        yield* reconciler.drain;
        active.add(ids[0]!);
        yield* reconciler.refresh(ids[0]!, "g1");
        yield* reconciler.drain;
        assert.equal(counts.get(ids[0]!), 5, "removal discarded the old retained identity");
        assert.equal(maxConcurrent, 1);
      }).pipe(Effect.provide(Reconciler.layer.pipe(Layer.provide(owners))));
    }).pipe(Effect.scoped),
);

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
      const terminalListener =
        yield* Deferred.make<(event: TerminalMetadataStreamEvent) => Effect.Effect<void>>();
      let workspaceRead = false;
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
        Layer.mock(Terminals.TerminalManager)({
          subscribeMetadata: (listener) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(terminalListener, listener);
              yield* listener({
                type: "snapshot",
                terminals: [
                  {
                    threadId: "other-owner",
                    terminalId: "shared-terminal",
                    cwd: "/shared",
                    worktreePath: null,
                    status: "running",
                    pid: 123,
                    exitCode: null,
                    exitSignal: null,
                    hasRunningSubprocess: true,
                    label: "Inert terminal",
                    updatedAt: "1970-01-01T00:00:00.000Z",
                  },
                ],
              } as TerminalMetadataStreamEvent);
              return () => {};
            }),
        }),
        Layer.mock(Outbox.EffectOutboxV2)({
          listParkedHandoffs: (input) =>
            Effect.gen(function* () {
              if (input.workspaceRoot !== undefined) {
                workspaceRead = true;
                return input.workspaceRoot === "/shared" ? [row] : [];
              }
              if (input.threadId !== undefined) yield* Queue.offer(refreshes, undefined);
              return input.after !== undefined
                ? []
                : input.threadId === undefined
                  ? [old, row]
                  : input.threadId === legacy
                    ? [old]
                    : input.threadId === source
                      ? [row]
                      : [];
            }),
        }),
        Layer.mock(Projections.ProjectionStoreV2)({
          getThreadShell: () => Effect.succeed(null),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamDomainEvents: Stream.fromQueue(events),
          listAppOwnedChildThreadIds: () => Effect.succeed([]),
          getThreadEventSequence: () => Effect.succeed(0),
        }),
        Layer.mock(Sessions.ProviderSessionManagerV2)({
          streamHandoffReadiness: Stream.fromQueue(readiness),
        }),
        Layer.succeed(Producer.HandoffApprovalProducer, {
          requestIfReady: (id) =>
            Effect.gen(function* () {
              count++;
              yield* Queue.offer(evaluated, id);
              if (count === 1) yield* Deferred.await(release);
              return yield* new HandoffParked({ message: "unknown", category: "unknown" });
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
        yield* (yield* Reconciler.HandoffParkedReconciler).drain;
        assert.equal(count, 1);
        yield* (yield* Reconciler.HandoffParkedReconciler).refresh(legacy);
        assert.equal(count, 1);
        yield* (yield* Deferred.await(terminalListener))({
          type: "remove",
          threadId: "other-owner",
          terminalId: "shared-terminal",
        });
        assert.isTrue(
          workspaceRead,
          "Closing another owner's terminal must invalidate the shared checkout",
        );
        assert.equal(yield* Queue.take(evaluated), source);
        assert.equal(count, 2);
      }).pipe(Effect.provide(Reconciler.layer.pipe(Layer.provide(owners))));
    }).pipe(Effect.scoped),
);
