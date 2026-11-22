import { assert, it } from "@effect/vitest";
import { CommandId, ThreadId, type OrchestrationV2AppThread } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import * as ThreadTakeover from "./ThreadTakeover.ts";

const now = DateTime.makeUnsafe(60_000);
const predecessorId = ThreadId.make("thread:predecessor");
const successorId = ThreadId.make("thread:successor");
const launchCommandId = CommandId.make("mcp:launch:successor");

type Relations = Parameters<typeof ThreadTakeover.admitTakeover>[0]["predecessor"];
const thread = (id: ThreadId, overrides: Partial<OrchestrationV2AppThread> = {}): Relations => ({
  id,
  lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
  archivedAt: null,
  deletedAt: null,
  ...overrides,
});
const predecessor = thread(predecessorId);
const successor = thread(successorId, {
  launchedBy: { threadId: predecessorId, commandId: launchCommandId, at: DateTime.makeUnsafe(0) },
});
const admit = (input: Partial<Parameters<typeof ThreadTakeover.admitTakeover>[0]> = {}) =>
  ThreadTakeover.admitTakeover({ predecessor, successor, now, predecessorUpstream: [], ...input });
const attempt = (
  threadId: ThreadId,
  state: "attempting" | "effective" | "timed_out",
  deadlineMs: number,
) => ({
  continuedBy: {
    threadId,
    transferId: "transfer",
    attempt: 1,
    state,
    deadlineAt: DateTime.makeUnsafe(deadlineMs),
  },
});

it("admits a successor that its predecessor launched, with a transfer id stable across restarts", () => {
  const admitted = admit();
  assert.deepEqual(admitted, {
    ok: true,
    transferId: ThreadTakeover.takeoverTransferId(predecessorId, successorId, launchCommandId),
  });
  // A restart recomputes the same id from durable state; another launch names another transfer.
  assert.deepEqual(admit(), admitted);
  assert.notEqual(
    ThreadTakeover.takeoverTransferId(predecessorId, successorId, "mcp:launch:other"),
    admitted.ok ? admitted.transferId : "",
  );
});

it("refuses a successor the predecessor did not launch as unproven", () => {
  // A user- or third-thread-created successor has no launcher, or another one, even after P sent to it.
  for (const launchedBy of [
    undefined,
    { threadId: ThreadId.make("thread:q"), commandId: launchCommandId, at: now },
  ])
    assert.include(admit({ successor: thread(successorId, launchedBy ? { launchedBy } : {}) }), {
      ok: false,
      code: "takeover_unproven",
    });
});

it.each([
  [
    "a subagent successor",
    {
      successor: {
        ...successor,
        lineage: {
          rootThreadId: predecessorId,
          parentThreadId: predecessorId,
          relationshipToParent: "subagent" as const,
        },
      },
    },
  ],
  [
    "a side chat predecessor",
    { predecessor: { ...predecessor, lineage: { ...predecessor.lineage, sideChat: true } } },
  ],
  ["an archived predecessor", { predecessor: { ...predecessor, archivedAt: now } }],
  ["a deleted successor", { successor: { ...successor, deletedAt: now } }],
  [
    "a successor that already continues another thread",
    {
      successor: {
        ...successor,
        continues: { threadId: ThreadId.make("thread:other"), transferId: "t", at: now },
      },
    },
  ],
  ["a continues cycle", { predecessorUpstream: [ThreadId.make("thread:x"), successorId] }],
])("refuses %s", (_name, input) => {
  assert.include(admit(input), { ok: false, code: "takeover_invalid" });
});

it("refuses a thread taking over itself", () => {
  const self = thread(predecessorId, {
    launchedBy: { threadId: predecessorId, commandId: launchCommandId, at: now },
  });
  assert.include(admit({ predecessor: self, successor: self }), {
    ok: false,
    code: "takeover_invalid",
  });
});

it("refuses a predecessor another successor took over or is taking over, until its attempt expires", () => {
  const other = ThreadId.make("thread:other-successor");
  for (const record of [attempt(other, "effective", 0), attempt(other, "attempting", 120_000)])
    assert.include(admit({ predecessor: { ...predecessor, ...record } }), {
      ok: false,
      code: "takeover_conflict",
    });
  for (const record of [
    attempt(other, "timed_out", 120_000),
    attempt(other, "attempting", 30_000),
    attempt(successorId, "attempting", 120_000),
  ])
    assert.isTrue(admit({ predecessor: { ...predecessor, ...record } }).ok);
});
