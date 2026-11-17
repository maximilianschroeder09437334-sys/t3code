import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ActivityLedger from "./ActivityLedger.ts";
import { reactToDomainEvent } from "./ActivityLedgerReactor.ts";

const projectId = ProjectId.make("project:ledger");
const threadId = ThreadId.make("thread:ledger");
const layer = ActivityLedger.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

const report = (key: string, summary = key) => ({
  key,
  kind: "progress" as const,
  projectId,
  threadId,
  summary,
});

it.layer(layer)("ActivityLedger", (it) => {
  it.effect("appends once per key, so a replayed write returns the first event", () =>
    Effect.gen(function* () {
      const ledger = yield* ActivityLedger.ActivityLedger;
      const first = yield* ledger.append(report("idem", "first"));
      const replay = yield* ledger.append(report("idem", "replayed text"));
      assert.isTrue(first.created);
      assert.isFalse(replay.created);
      assert.deepStrictEqual(replay.event, first.event);
      const events = yield* ledger.list({ limit: 500 });
      assert.strictEqual(events.filter((event) => event.id === first.event.id).length, 1);
    }),
  );

  it.effect("rejects a summary over three lines before writing", () =>
    Effect.gen(function* () {
      const ledger = yield* ActivityLedger.ActivityLedger;
      const error = yield* ledger.append(report("four-lines", "a\nb\nc\nd")).pipe(Effect.flip);
      assert.strictEqual(error._tag, "ActivityLedgerError");
      const events = yield* ledger.list({ limit: 500 });
      assert.isFalse(events.some((event) => event.summary.startsWith("a\nb")));
    }),
  );

  it.effect("returns only events after the user's check-in and never moves it backwards", () =>
    Effect.gen(function* () {
      const ledger = yield* ActivityLedger.ActivityLedger;
      assert.isNull(yield* ledger.getCheckIn("owner"));
      yield* ledger.append(report("before-1"));
      const seen = yield* ledger.append(report("before-2"));
      const marked = yield* ledger.markSeen("owner");
      assert.strictEqual(marked.seenSequence, seen.event.sequence);
      const after = yield* ledger.append({
        ...report("after"),
        kind: "done",
        featureKey: "relay-p1",
        tests: { ran: "vp test run", result: "passed" },
        links: { commits: ["abc123"] },
      });

      const since = yield* ledger.sinceCheckIn("owner");
      assert.deepStrictEqual(
        since.events.map((event) => event.id),
        [after.event.id],
      );
      assert.deepStrictEqual(since.events[0]?.tests, { ran: "vp test run", result: "passed" });
      assert.deepStrictEqual(since.events[0]?.links, { commits: ["abc123"] });
      assert.isFalse(since.truncated);
      // Another user's check-in is separate.
      assert.isNull((yield* ledger.sinceCheckIn("other")).checkIn);

      const stale = yield* ledger.markSeen("owner", seen.event.sequence - 1);
      assert.strictEqual(stale.seenSequence, seen.event.sequence);
      assert.deepStrictEqual(
        (yield* ledger.list({ limit: 10, featureKey: "relay-p1", kinds: ["done"] })).map(
          (event) => event.id,
        ),
        [after.event.id],
      );
    }),
  );

  it.effect("streams only events after the cursor, without replaying older history", () =>
    Effect.gen(function* () {
      const ledger = yield* ActivityLedger.ActivityLedger;
      const old = yield* ledger.append(report("stream-old"));
      const fiber = yield* ledger
        .stream({ afterSequence: old.event.sequence })
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
      const a = yield* ledger.append(report("stream-a"));
      const b = yield* ledger.append(report("stream-b"));
      const streamed = yield* Fiber.join(fiber);
      assert.deepStrictEqual(
        streamed.map((event) => event.id),
        [a.event.id, b.event.id],
      );
    }),
  );

  it.effect("records a settled thread once even when the domain event is replayed", () =>
    Effect.gen(function* () {
      const ledger = yield* ActivityLedger.ActivityLedger;
      const shell = {
        id: threadId,
        projectId,
        title: "Relay P1",
      } as unknown as OrchestrationV2ThreadShell;
      const event = {
        id: "event:settled-1",
        type: "thread.settled",
        threadId,
      } as unknown as OrchestrationV2DomainEvent;
      const react = reactToDomainEvent(event).pipe(
        Effect.provide(
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadShell: () => Effect.succeed(shell),
          }),
        ),
      );
      yield* react;
      yield* react;
      const settled = yield* ledger.list({ limit: 10, kinds: ["settled"] });
      assert.deepStrictEqual(
        settled.map((entry) => [entry.threadId, entry.projectId, entry.summary]),
        [[threadId, projectId, "Settled: Relay P1"]],
      );
    }),
  );
});
