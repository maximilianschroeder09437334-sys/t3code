import { assert, it } from "@effect/vitest";
import {
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type ThreadContextUsageUpdate as Usage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadContextUsage from "./ThreadContextUsage.ts";

const running = ThreadId.make("thread:running");
const fresh = ThreadId.make("thread:fresh");
const gone = ThreadId.make("thread:gone");
const active = ProviderThreadId.make("provider-thread:active");
const retired = ProviderThreadId.make("provider-thread:retired");

const turn = (providerThreadId: ProviderThreadId, usedTokens: number, updatedAt: string) => ({
  providerThreadId,
  tokenUsage: { usedTokens, maxTokens: 200_000, updatedAt },
});

const turnEvent = (threadId: ThreadId, payload: ReturnType<typeof turn>) =>
  ({ type: "provider-turn.updated", threadId, payload }) as unknown as OrchestrationV2DomainEvent;

it("prefers the active conversation's newest turn report over the provider thread's own", () => {
  const providerThreads = [
    {
      id: active,
      contextUsage: { usedTokens: 10 },
      updatedAt: DateTime.makeUnsafe("2026-11-19T10:00:00.000Z"),
    },
  ];
  assert.deepStrictEqual(
    ThreadContextUsage.latestContextUsage({
      threadId: running,
      activeProviderThreadId: active,
      providerThreads,
      providerTurns: [
        turn(active, 40_000, "2026-11-19T10:01:00.000Z"),
        turn(retired, 190_000, "2026-11-19T10:05:00.000Z"),
        turn(active, 60_000, "2026-11-19T10:02:00.000Z"),
      ],
    }),
    {
      threadId: running,
      usedTokens: 60_000,
      maxTokens: 200_000,
      updatedAt: "2026-11-19T10:02:00.000Z",
    },
  );
  // Without a turn report the provider thread's usage stands, and its window stays unknown.
  assert.deepStrictEqual(
    ThreadContextUsage.latestContextUsage({
      threadId: running,
      activeProviderThreadId: active,
      providerThreads,
      providerTurns: [],
    }),
    { threadId: running, usedTokens: 10, maxTokens: null, updatedAt: "2026-11-19T10:00:00.000Z" },
  );
});

it.effect("streams known usage once, then only changes from the active conversation", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const received = yield* Queue.unbounded<Usage>();
    let current = active;
    let tokens = 40_000;
    const orchestrator = Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadShell: (threadId) =>
        Effect.succeed(
          threadId === gone ? null : ({ id: threadId } as unknown as OrchestrationV2ThreadShell),
        ),
      getThreadRecords: ((threadId: ThreadId) =>
        Effect.succeed({
          thread: { activeProviderThreadId: current },
          providerThreads: [],
          providerTurns:
            threadId === running
              ? [
                  turn(
                    active,
                    tokens,
                    tokens === 40_000 ? "2026-11-19T10:01:00.000Z" : "2026-11-19T10:05:00.000Z",
                  ),
                ]
              : [],
        })) as never,
      streamDomainEvents: Stream.fromQueue(events),
    });
    yield* ThreadContextUsage.stream([running, fresh, gone]).pipe(
      Stream.runForEach((usage) => Queue.offer(received, usage)),
      Effect.provide(orchestrator),
      Effect.forkScoped,
    );

    // Every requested thread reports its current state, including unknown.
    const initial = [
      yield* Queue.take(received),
      yield* Queue.take(received),
      yield* Queue.take(received),
    ];
    assert.deepStrictEqual(initial.find((value) => value.threadId === running)?.usage, {
      threadId: running,
      usedTokens: 40_000,
      maxTokens: 200_000,
      updatedAt: "2026-11-19T10:01:00.000Z",
    });
    assert.strictEqual(initial.find((value) => value.threadId === fresh)?.usage, null);
    assert.strictEqual(initial.find((value) => value.threadId === gone)?.usage, null);

    tokens = 75_000;
    yield* Queue.offerAll(events, [
      // A subagent's or retired conversation's report is not this thread's context.
      turnEvent(running, turn(retired, 190_000, "2026-11-19T10:03:00.000Z")),
      // An older turn updated late must not move the gauge backwards.
      turnEvent(running, turn(active, 20_000, "2026-11-19T10:00:00.000Z")),
      // An unchanged value is not worth a frame on the wire.
      turnEvent(running, turn(active, 40_000, "2026-11-19T10:04:00.000Z")),
      turnEvent(running, turn(active, 75_000, "2026-11-19T10:05:00.000Z")),
    ]);
    assert.deepStrictEqual((yield* Queue.take(received)).usage, {
      threadId: running,
      usedTokens: 75_000,
      maxTokens: 200_000,
      updatedAt: "2026-11-19T10:05:00.000Z",
    });
    current = retired;
    yield* Queue.offer(events, {
      type: "provider-thread.updated",
      threadId: running,
    } as OrchestrationV2DomainEvent);
    assert.deepStrictEqual(yield* Queue.take(received), { threadId: running, usage: null });
    assert.strictEqual(yield* Queue.size(received), 0);
  }).pipe(Effect.scoped),
);
