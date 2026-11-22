// @effect-diagnostics nodeBuiltinImport:off -- Reads and writes the compatibility gate's fixtures.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "vite-plus/test";
import {
  EnvironmentId,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ShellStreamItem,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { presentThreadShell } from "../../../../packages/client-runtime/src/state/models.ts";
import {
  v2ShellSnapshot,
  v2ThreadShell,
} from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import {
  resolveThreadWaits,
  threadWaitKey,
} from "../../../../packages/client-runtime/src/state/threadWait.ts";

// New side of scripts/waiting-display-compat-gate.ts: T3_WAIT_COMPAT_WRITE writes fixtures for the
// baseline client, T3_WAIT_COMPAT_READ reads the baseline's. Without either, only the round trip runs.

const environmentId = EnvironmentId.make("env-compat");
const shell = (id: string, overrides: Partial<OrchestrationV2ThreadShell> = {}) =>
  ({
    ...v2ThreadShell,
    id: ThreadId.make(id),
    title: id,
    lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
    ...overrides,
  }) satisfies OrchestrationV2ThreadShell;
const subagentOf = (parent: string) => ({
  rootThreadId: ThreadId.make(parent),
  parentThreadId: ThreadId.make(parent),
  relationshipToParent: "subagent" as const,
});
const completed = {
  status: "completed" as const,
  latestRunId: "run-compat" as never,
  waitPhase: "ended" as const,
  waitingOn: [],
};
const running = (id: string) => ({
  status: "running" as const,
  latestRunId: `run-${id}` as never,
  activeRunId: `run-${id}` as never,
  activityRunStatus: "running" as const,
  waitPhase: "working" as const,
  waitingOn: [],
});

/** The new server's shells for every slice A shape. */
const newServerShells: ReadonlyArray<OrchestrationV2ThreadShell> = [
  // A1: an awaited command and pending PR checks, each a thread-less awaited_child target.
  shell("command-owner", {
    ...completed,
    waitPhase: "waiting",
    pendingBackgroundTasks: [
      { taskId: "bwngue5o4", kind: "command", awaited: true, description: "vp test" },
    ],
    waitingOn: [
      {
        source: "awaited_child",
        environmentId: null,
        threadId: null,
        title: "vp test",
        taskId: "bwngue5o4",
      },
    ],
  }),
  shell("pr-owner", {
    ...completed,
    waitPhase: "waiting",
    waitingOn: [
      {
        source: "awaited_child",
        environmentId: null,
        threadId: null,
        title: "PR #42 checks",
        taskId: "pull-request-watch:github.com/owner/repo#42",
      },
    ],
  }),
  // A2: a lineage-only parent; A3: a sender of a child's open run.
  shell("parent", completed),
  shell("child", { ...running("child"), lineage: subagentOf("parent") }),
  shell("sender", completed),
  shell("sent-child", {
    ...running("sent-child"),
    lineage: subagentOf("parent"),
    latestRunSenderThreadId: ThreadId.make("sender"),
  }),
];

const encodeSnapshot = Schema.encodeUnknownSync(Schema.toCodecJson(OrchestrationV2ShellSnapshot));
const decodeSnapshot = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ShellSnapshot));
const encodeItem = Schema.encodeUnknownSync(Schema.toCodecJson(OrchestrationV2ShellStreamItem));
const decodeItem = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ShellStreamItem));

const resolveAll = (threads: ReadonlyArray<OrchestrationV2ThreadShell>) =>
  resolveThreadWaits({
    threads: threads.map((thread) => presentThreadShell(environmentId, thread)),
    environmentReady: () => true,
  });
const waiting = (waits: ReturnType<typeof resolveAll>, id: string) =>
  waits.get(threadWaitKey(environmentId, ThreadId.make(id)))?.waiting;

describe("waiting display wire compatibility (WP A4)", () => {
  it("round-trips the new shells through the wire schema and resolves every shape", () => {
    const snapshot = decodeSnapshot(
      JSON.parse(JSON.stringify(encodeSnapshot({ ...v2ShellSnapshot, threads: newServerShells }))),
    );
    const waits = resolveAll(snapshot.threads);
    assert.isTrue(waiting(waits, "command-owner"));
    assert.isTrue(waiting(waits, "pr-owner"));
    assert.isTrue(waiting(waits, "parent"));
    assert.isTrue(waiting(waits, "sender"));
    assert.equal(
      snapshot.threads.find((thread) => thread.id === "sent-child")?.latestRunSenderThreadId,
      "sender",
    );
  });

  const writeDir = process.env.T3_WAIT_COMPAT_WRITE;
  it.runIf(writeDir !== undefined)("writes the new server's snapshot and delta fixtures", () => {
    NodeFS.mkdirSync(writeDir!, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(writeDir!, "new-snapshot.json"),
      JSON.stringify(encodeSnapshot({ ...v2ShellSnapshot, threads: newServerShells })),
    );
    NodeFS.writeFileSync(
      NodePath.join(writeDir!, "new-deltas.json"),
      JSON.stringify(
        newServerShells.map((thread, index) =>
          encodeItem({ kind: "thread.updated", sequence: index + 1, location: "active", thread }),
        ),
      ),
    );
  });

  const readDir = process.env.T3_WAIT_COMPAT_READ;
  it.runIf(readDir !== undefined)(
    "decodes and resolves the baseline server's fixtures under the new client",
    () => {
      const read = (name: string) =>
        JSON.parse(NodeFS.readFileSync(NodePath.join(readDir!, name), "utf8")) as unknown;
      const snapshot = decodeSnapshot(read("base-snapshot.json"));
      const deltas = (read("base-deltas.json") as ReadonlyArray<unknown>).map((item) =>
        decodeItem(item),
      );
      assert.isAbove(deltas.length, 0);
      const waits = resolveAll(snapshot.threads);
      // A baseline r3 parent with a working lineage child: the new client adds the edge.
      assert.isTrue(waiting(waits, "base-parent"));
      // No sender field from the baseline server: the lineage rule applies.
      assert.isUndefined(
        snapshot.threads.find((thread) => thread.id === "base-child")?.latestRunSenderThreadId,
      );
      // A pre-r3 shell (no waitPhase) gets no entry, so it keeps the legacy display.
      assert.isUndefined(waits.get(threadWaitKey(environmentId, ThreadId.make("base-legacy"))));
    },
  );
});
