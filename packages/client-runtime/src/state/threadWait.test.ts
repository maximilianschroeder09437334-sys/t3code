import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  TurnItemId,
  isLiveSubagentShell,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2WaitTarget,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { presentThreadShell } from "./models.ts";
import { v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { applyShellStreamEvent } from "./shellReducer.ts";
import {
  THREAD_WAIT_DEPTH_LIMIT,
  resolveThreadWaits,
  threadWaitKey,
  type ThreadWaitResolveStats,
} from "./threadWait.ts";

const env1 = EnvironmentId.make("env-1");
const env2 = EnvironmentId.make("env-2");

const raw = (id: string, overrides: Partial<OrchestrationV2ThreadShell> = {}) =>
  ({
    ...v2ThreadShell,
    id: ThreadId.make(id),
    title: id,
    lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
    ...overrides,
  }) satisfies OrchestrationV2ThreadShell;

const on = (
  threadId: string | null,
  extra: Partial<OrchestrationV2WaitTarget> = {},
): OrchestrationV2WaitTarget => ({
  source: "thread_wait",
  environmentId: null,
  threadId: threadId === null ? null : ThreadId.make(threadId),
  title: null,
  ...extra,
});

const waiting = (id: string, targets: ReadonlyArray<OrchestrationV2WaitTarget>) =>
  raw(id, { waitPhase: "waiting", waitingOn: [...targets] });
const phase = (id: string, waitPhase: OrchestrationV2ThreadShell["waitPhase"]) =>
  raw(id, { waitPhase, waitingOn: [] });

const resolve = (
  environments: ReadonlyArray<readonly [EnvironmentId, ReadonlyArray<OrchestrationV2ThreadShell>]>,
  options: {
    readonly notReady?: ReadonlyArray<EnvironmentId>;
    readonly stats?: ThreadWaitResolveStats;
  } = {},
) =>
  resolveThreadWaits({
    threads: environments.flatMap(([environmentId, threads]) =>
      threads.map((thread) => presentThreadShell(environmentId, thread)),
    ),
    environmentReady: (environmentId) => !(options.notReady ?? []).includes(environmentId),
    ...(options.stats === undefined ? {} : { stats: options.stats }),
  });
const waitOf = (
  result: ReturnType<typeof resolveThreadWaits>,
  id: string,
  environmentId: EnvironmentId = env1,
) => result.get(threadWaitKey(environmentId, id));

describe("resolveThreadWaits", () => {
  it("follows the target's own phase", () => {
    const a = waiting("a", [on("b")]);
    const cases = [
      ["working", true, "live", undefined],
      ["needs", true, "live", "needs you"],
      ["ended", false, "ended", undefined],
    ] as const;
    for (const [targetPhase, expectedWaiting, state, suffix] of cases) {
      const wait = waitOf(resolve([[env1, [a, phase("b", targetPhase)]]]), "a");
      expect(wait?.waiting, targetPhase).toBe(expectedWaiting);
      expect(wait?.targets).toEqual([
        {
          title: "b",
          environmentId: env1,
          threadId: ThreadId.make("b"),
          waiterThreadId: ThreadId.make("a"),
          source: "thread_wait",
          state,
          ...(suffix === undefined ? {} : { suffix }),
        },
      ]);
    }
  });

  it("ends on a finished, failed, cancelled or interrupted target from either server", () => {
    const a = waiting("a", [on("b")]);
    // New servers report the target's phase; ended covers every terminal run.
    expect(waitOf(resolve([[env1, [a, phase("b", "ended")]]]), "a")?.waiting).toBe(false);
    // Old servers send no phase; the legacy classifier reads the run and lifecycle.
    const legacy = (overrides: Partial<OrchestrationV2ThreadShell>) =>
      waitOf(
        resolve([[env1, [a, raw("b", { latestRunId: "run-b" as never, ...overrides })]]]),
        "a",
      );
    for (const status of ["failed", "cancelled", "interrupted", "completed"] as const) {
      expect(legacy({ status })?.waiting, status).toBe(false);
    }
    expect(legacy({ status: "running", activeRunId: "run-b" as never })?.waiting).toBe(true);
    expect(legacy({ status: "running", archivedAt: v2ThreadShell.updatedAt })?.waiting).toBe(false);
    expect(legacy({ status: "running", settledOverride: "settled" })?.waiting).toBe(false);
    // Only threads from new servers get an entry; old waiters keep their old status rules.
    expect(waitOf(resolve([[env1, [raw("old")]]]), "old")).toBeUndefined();
  });

  it("clears when the target is archived or removed through real shell deltas", () => {
    const a = waiting("a", [on("b")]);
    const b = { ...phase("b", "working"), projectId: ProjectId.make("project-other") };
    let snapshot: OrchestrationV2ShellSnapshot = {
      ...v2ShellSnapshot,
      snapshotSequence: 1,
      threads: [a, b],
    };
    const fromSnapshot = (current: OrchestrationV2ShellSnapshot) =>
      waitOf(resolve([[env1, current.threads]]), "a")?.waiting;
    expect(fromSnapshot(snapshot)).toBe(true);

    const archived = applyShellStreamEvent(snapshot, {
      kind: "thread.updated",
      sequence: 2,
      location: "archive",
      thread: { ...b, archivedAt: v2ThreadShell.updatedAt, waitPhase: "ended" },
    });
    expect(fromSnapshot(archived)).toBe(false);
    const unarchived = applyShellStreamEvent(archived, {
      kind: "thread.updated",
      sequence: 3,
      location: "active",
      thread: b,
    });
    expect(fromSnapshot(unarchived)).toBe(true);
    snapshot = applyShellStreamEvent(unarchived, {
      kind: "thread.removed",
      location: "active",
      sequence: 4,
      threadId: b.id,
    });
    expect(fromSnapshot(snapshot)).toBe(false);
    // A fresh snapshot after the removal agrees, with A itself unchanged throughout.
    expect(fromSnapshot({ ...v2ShellSnapshot, snapshotSequence: 5, threads: [a] })).toBe(false);
  });

  it("keeps a waiter waiting through an omitted-live subagent chain, across reconnects", () => {
    // A awaits subagent B, whose completed report waits on C in another environment.
    const subagentOf = (id: string, parent: string) => ({
      rootThreadId: ThreadId.make(parent),
      parentThreadId: ThreadId.make(parent),
      relationshipToParent: "subagent" as const,
    });
    const a = waiting("a", [on("b", { source: "subagent" })]);
    const b = {
      ...waiting("b", [
        on("c", { source: "report_wait", environmentId: env2, title: "C in env 2" }),
      ]),
      status: "completed" as const,
      lineage: subagentOf("b", "a"),
    };
    const idle = { ...phase("idle", "ended"), lineage: subagentOf("idle", "a") };
    // The server's idle-subagent trim keeps a subagent only while it is live; a waiting phase is.
    const trim = (threads: ReadonlyArray<OrchestrationV2ThreadShell>) =>
      threads.filter(
        (thread) =>
          thread.lineage.relationshipToParent !== "subagent" || isLiveSubagentShell(thread),
      );
    const env1Threads = trim([a, b, idle]);
    expect(env1Threads.map((thread) => thread.id)).toEqual([a.id, b.id]);

    const run = (cPhase: "working" | "ended", notReady: ReadonlyArray<EnvironmentId> = []) =>
      resolve(
        [
          [env1, env1Threads],
          [env2, [phase("c", cPhase)]],
        ],
        { notReady },
      );
    expect(waitOf(run("working"), "a")?.waiting).toBe(true);
    expect(waitOf(run("working"), "b")?.targets[0]).toMatchObject({
      title: "C in env 2",
      environmentId: env2,
      state: "live",
    });
    expect(waitOf(run("ended"), "a")?.waiting).toBe(false);
    expect(waitOf(run("ended"), "b")?.waiting).toBe(false);
    // Reconnecting: env 2 not ready yet keeps the chain waiting as "not connected"; once its
    // fresh snapshot is live the result is the same as before the reconnect.
    const reconnecting = run("ended", [env2]);
    expect(waitOf(reconnecting, "a")?.waiting).toBe(true);
    expect(waitOf(reconnecting, "b")?.targets[0]).toMatchObject({
      state: "unknown",
      suffix: "not connected",
    });
    expect(waitOf(run("ended"), "a")?.waiting).toBe(false);
    expect(waitOf(run("working"), "a")?.waiting).toBe(true);
  });

  it("marks a target in a linked environment that is not ready as not connected", () => {
    const a = waiting("a", [on("remote", { environmentId: env2, title: "Remote task" })]);
    const wait = waitOf(resolve([[env1, [a]]], { notReady: [env2] }), "a");
    expect(wait?.waiting).toBe(true);
    expect(wait?.targets[0]).toMatchObject({
      title: "Remote task",
      environmentId: env2,
      state: "unknown",
      suffix: "not connected",
    });
    // Ready but absent: gone.
    expect(
      waitOf(
        resolve([
          [env1, [a]],
          [env2, []],
        ]),
        "a",
      )?.waiting,
    ).toBe(false);
  });

  it("keeps null-thread targets live until the waiter re-projects without them", () => {
    const itemId = TurnItemId.make("item-native");
    const native = waiting("a", [
      on(null, { source: "subagent", title: "Explore", itemId, taskId: "native-1" }),
    ]);
    const nativeWait = waitOf(resolve([[env1, [native]]]), "a");
    expect(nativeWait?.waiting).toBe(true);
    expect(nativeWait?.targets[0]).toEqual({
      title: "Explore",
      environmentId: env1,
      threadId: null,
      waiterThreadId: ThreadId.make("a"),
      itemId,
      taskId: "native-1",
      source: "subagent",
      state: "live",
    });
    const delegate = waiting("a", [on(null, { source: "delegate_wait", itemId })]);
    expect(waitOf(resolve([[env1, [delegate]]]), "a")?.targets[0]).toMatchObject({
      title: "starting delegate",
      state: "live",
      suffix: "starting",
    });
    expect(
      waitOf(resolve([[env1, [waiting("a", [on(null, { source: "awaited_child" })])]]]), "a")
        ?.targets[0]?.title,
    ).toBe("a subagent");
    // The item completed: the waiter's next shell has no target and is working or ended.
    expect(waitOf(resolve([[env1, [phase("a", "working")]]]), "a")?.waiting).toBe(false);
    expect(waitOf(resolve([[env1, [phase("a", "ended")]]]), "a")?.waiting).toBe(false);
  });

  it("waits while any of several targets is live", () => {
    const a = waiting("a", [on("done"), on("busy"), on("gone")]);
    const both = resolve([[env1, [a, phase("done", "ended"), phase("busy", "working")]]]);
    expect(waitOf(both, "a")?.waiting).toBe(true);
    expect(waitOf(both, "a")?.targets.map((target) => target.state)).toEqual([
      "ended",
      "live",
      "ended",
    ]);
    expect(
      waitOf(resolve([[env1, [a, phase("done", "ended"), phase("busy", "ended")]]]), "a")?.waiting,
    ).toBe(false);
  });

  it("ends a pure cycle but keeps a cycle with a live exit waiting", () => {
    const pure = resolve([[env1, [waiting("a", [on("b")]), waiting("b", [on("a")])]]]);
    expect(waitOf(pure, "a")?.waiting).toBe(false);
    expect(waitOf(pure, "b")?.waiting).toBe(false);
    const withExit = resolve([
      [env1, [waiting("a", [on("b")]), waiting("b", [on("a"), on("c")]), phase("c", "working")]],
    ]);
    expect(waitOf(withExit, "a")?.waiting).toBe(true);
    expect(waitOf(withExit, "b")?.waiting).toBe(true);
  });

  it("counts a chain deeper than the limit as still live", () => {
    const chain = (length: number) => [
      ...Array.from({ length }, (_, index) => waiting(`t${index}`, [on(`t${index + 1}`)])),
      phase(`t${length}`, "ended"),
    ];
    // Within the limit the answer is exact.
    const short = resolve([[env1, chain(THREAD_WAIT_DEPTH_LIMIT - 2)]]);
    expect(waitOf(short, "t0")?.waiting).toBe(false);
    // Beyond it the unexplored rest counts as live; the thread next to the end is still exact.
    const long = THREAD_WAIT_DEPTH_LIMIT * 3;
    const deep = resolve([[env1, chain(long)]]);
    expect(waitOf(deep, "t0")?.waiting).toBe(true);
    expect(waitOf(deep, `t${long - 1}`)?.waiting).toBe(false);
  });

  it("visits each thread and edge once on a wide converging graph", () => {
    const layers = 12;
    const width = 24;
    const threads: Array<OrchestrationV2ThreadShell> = [];
    let edges = 0;
    for (let layer = 0; layer < layers; layer++) {
      for (let index = 0; index < width; index++) {
        if (layer === layers - 1) {
          threads.push(phase(`l${layer}-${index}`, "working"));
          continue;
        }
        const targets = Array.from({ length: width }, (_, next) => on(`l${layer + 1}-${next}`));
        edges += targets.length;
        threads.push(waiting(`l${layer}-${index}`, targets));
      }
    }
    const stats: ThreadWaitResolveStats = { ops: 0 };
    const result = resolve([[env1, threads]], { stats });
    expect(waitOf(result, "l0-0")?.waiting).toBe(true);
    // Without one shared memo this graph takes width^layers steps.
    expect(stats.ops).toBeLessThanOrEqual(2 * (threads.length + edges));
  });
});
