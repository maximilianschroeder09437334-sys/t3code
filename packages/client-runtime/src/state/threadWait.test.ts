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
          kind: "thread",
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

  it("keeps a waiter waiting on a trimmed-in needs-you subagent, across reconnects", () => {
    const subagentOf = (parent: string) => ({
      rootThreadId: ThreadId.make(parent),
      parentThreadId: ThreadId.make(parent),
      relationshipToParent: "subagent" as const,
    });
    const a = waiting("a", [on("b", { source: "awaited_child" })]);
    // B finished; its report asks Maxi (or a guest wrote): no run, request or task holds it.
    const b = { ...phase("b", "needs"), status: "completed" as const, lineage: subagentOf("a") };
    const trim = (threads: ReadonlyArray<OrchestrationV2ThreadShell>) =>
      threads.filter(
        (thread) =>
          thread.lineage.relationshipToParent !== "subagent" || isLiveSubagentShell(thread),
      );
    const kept = trim([a, b]);
    expect(kept.map((thread) => thread.id)).toEqual([a.id, b.id]);
    const ready = resolve([[env1, kept]]);
    expect(waitOf(ready, "a")?.waiting).toBe(true);
    expect(waitOf(ready, "a")?.targets[0]).toMatchObject({ state: "live", suffix: "needs you" });
    const reconnecting = resolve([[env1, kept]], { notReady: [env1] });
    expect(waitOf(reconnecting, "a")?.waiting).toBe(true);
    expect(waitOf(reconnecting, "a")?.targets[0]).toMatchObject({ suffix: "not connected" });
    expect(waitOf(resolve([[env1, kept]]), "a")?.targets[0]?.suffix).toBe("needs you");
    // Once B ends the trim drops it and A clears.
    const after = trim([a, { ...b, waitPhase: "ended" }]);
    expect(after.map((thread) => thread.id)).toEqual([a.id]);
    expect(waitOf(resolve([[env1, after]]), "a")?.waiting).toBe(false);
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
      kind: "subagent",
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

  it("gives the same answer for a cycle with a live exit in every shell order", () => {
    // A waits on B and C, B waits back on A, C works; D waits on B from outside the cycle.
    const permutations = <T>(items: ReadonlyArray<T>): Array<Array<T>> =>
      items.length <= 1
        ? [[...items]]
        : items.flatMap((item, index) =>
            permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
              item,
              ...rest,
            ]),
          );
    const shellsFor = (cPhase: "working" | "ended") => [
      waiting("a", [on("b"), on("c")]),
      waiting("b", [on("a")]),
      phase("c", cPhase),
      waiting("d", [on("b")]),
    ];
    /** Every target that is itself a waiting thread reads exactly that thread's final result. */
    const assertTargetsAgree = (
      result: ReturnType<typeof resolveThreadWaits>,
      threads: ReadonlyArray<OrchestrationV2ThreadShell>,
      label: string,
    ) => {
      const waitingIds = new Set(
        threads.filter((thread) => thread.waitPhase === "waiting").map((thread) => thread.id),
      );
      for (const [key, wait] of result) {
        for (const target of wait.targets) {
          if (target.threadId === null || !waitingIds.has(target.threadId)) continue;
          const own = waitOf(result, target.threadId)?.waiting;
          expect(target.state, `${label} ${key} -> ${target.threadId}`).toBe(
            own ? "live" : "ended",
          );
        }
      }
    };
    const orders = permutations(shellsFor("working").map((_, index) => index));
    expect(orders).toHaveLength(24);
    for (const cPhase of ["working", "ended"] as const) {
      const threads = shellsFor(cPhase);
      for (const order of orders) {
        const ordered = order.map((index) => threads[index]!);
        const label = `${cPhase} ${ordered.map((thread) => thread.id).join(",")}`;
        const result = resolve([[env1, ordered]]);
        const expected = cPhase === "working";
        for (const id of ["a", "b", "d"]) {
          expect(waitOf(result, id)?.waiting, `${label} ${id}`).toBe(expected);
        }
        assertTargetsAgree(result, ordered, label);
      }
    }
  });

  it("follows long chains and cycles without recursion", () => {
    // A ring of 5000 waiting threads with one live exit at the far end, in both directions.
    const size = 5000;
    const ring = Array.from({ length: size }, (_, index) =>
      waiting(`r${index}`, [
        on(`r${(index + 1) % size}`),
        ...(index === size - 1 ? [on("busy")] : []),
      ]),
    );
    for (const threads of [ring, [...ring].reverse()]) {
      const result = resolve([[env1, [...threads, phase("busy", "working")]]]);
      expect(waitOf(result, "r0")?.waiting).toBe(true);
      expect(waitOf(result, `r${size - 1}`)?.waiting).toBe(true);
      const ended = resolve([[env1, [...threads, phase("busy", "ended")]]]);
      expect(waitOf(ended, "r0")?.waiting).toBe(false);
      expect(waitOf(ended, `r${size - 1}`)?.waiting).toBe(false);
    }
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
    const deep = chain(long);
    // The cut sits at the same thread whatever the shell order.
    for (const threads of [deep, [...deep].reverse()]) {
      const result = resolve([[env1, threads]]);
      expect(waitOf(result, "t0")?.waiting).toBe(true);
      expect(waitOf(result, `t${long - 1}`)?.waiting).toBe(false);
      const lastCut = long - THREAD_WAIT_DEPTH_LIMIT - 1;
      expect(waitOf(result, `t${lastCut}`)?.waiting).toBe(true);
      expect(waitOf(result, `t${lastCut + 1}`)?.waiting).toBe(false);
      // Only the cut target reads live while its own result is not waiting.
      expect(waitOf(result, `t${lastCut}`)?.targets[0]?.state).toBe("live");
    }
    // Exactly at the limit the answer is still exact; one more thread is cut.
    expect(waitOf(resolve([[env1, chain(THREAD_WAIT_DEPTH_LIMIT)]]), "t0")?.waiting).toBe(false);
    expect(waitOf(resolve([[env1, chain(THREAD_WAIT_DEPTH_LIMIT + 1)]]), "t0")?.waiting).toBe(true);
  });

  it("visits each thread and edge a bounded number of times on a wide converging graph", () => {
    const layers = 12;
    const width = 24;
    const graph = (lastPhase: "working" | "ended") => {
      const threads: Array<OrchestrationV2ThreadShell> = [];
      let edges = 0;
      for (let layer = 0; layer < layers; layer++) {
        for (let index = 0; index < width; index++) {
          if (layer === layers - 1) {
            threads.push(phase(`l${layer}-${index}`, lastPhase));
            continue;
          }
          const targets = Array.from({ length: width }, (_, next) => on(`l${layer + 1}-${next}`));
          edges += targets.length;
          threads.push(waiting(`l${layer}-${index}`, targets));
        }
      }
      return { threads, edges };
    };
    // A live bottom layer: classify plus one backward spread.
    const liveGraph = graph("working");
    const stats: ThreadWaitResolveStats = { ops: 0 };
    const result = resolve([[env1, liveGraph.threads]], { stats });
    expect(waitOf(result, "l0-0")?.waiting).toBe(true);
    // A walk per path would take width^layers steps.
    expect(stats.ops).toBeLessThanOrEqual(2 * (liveGraph.threads.length + liveGraph.edges));
    // An ended bottom layer also runs the SCC height pass, still linear.
    const endedGraph = graph("ended");
    const endedStats: ThreadWaitResolveStats = { ops: 0 };
    const ended = resolve([[env1, endedGraph.threads]], { stats: endedStats });
    expect(waitOf(ended, "l0-0")?.waiting).toBe(false);
    expect(endedStats.ops).toBeLessThanOrEqual(4 * (endedGraph.threads.length + endedGraph.edges));
  });
});

describe("resolveThreadWaits implicit lineage and sender edges (WP A2, A3)", () => {
  const subagentOf = (parent: string) => ({
    rootThreadId: ThreadId.make(parent),
    parentThreadId: ThreadId.make(parent),
    relationshipToParent: "subagent" as const,
  });
  /** A completed, unsettled thread with nothing of its own left: the server says ended. */
  const done = (id: string, overrides: Partial<OrchestrationV2ThreadShell> = {}) =>
    raw(id, {
      waitPhase: "ended",
      waitingOn: [],
      status: "completed",
      latestRunId: `run-${id}` as never,
      ...overrides,
    });
  /** A subagent child whose run is open. */
  const busyChild = (
    id: string,
    parent: string,
    overrides: Partial<OrchestrationV2ThreadShell> = {},
  ) =>
    raw(id, {
      lineage: subagentOf(parent),
      waitPhase: "working",
      waitingOn: [],
      status: "running",
      latestRunId: `run-${id}` as never,
      activeRunId: `run-${id}` as never,
      activityRunStatus: "running",
      ...overrides,
    });
  const childDone = (
    id: string,
    parent: string,
    overrides: Partial<OrchestrationV2ThreadShell> = {},
  ) => done(id, { lineage: subagentOf(parent), ...overrides });

  it("a completed unsettled parent waits on its working lineage child, then clears when it ends", () => {
    const parent = done("p");
    const live = resolve([[env1, [parent, busyChild("c", "p")]]]);
    expect(waitOf(live, "p")).toEqual({
      waiting: true,
      targets: [
        {
          title: "c",
          environmentId: env1,
          threadId: ThreadId.make("c"),
          waiterThreadId: ThreadId.make("p"),
          source: "awaited_child",
          kind: "subagent",
          state: "live",
        },
      ],
    });
    // The same pair once the child's run completed: nothing holds the parent.
    const ended = resolve([[env1, [parent, childDone("c", "p")]]]);
    expect(waitOf(ended, "p")?.waiting).toBe(false);
    expect(waitOf(ended, "p")?.targets).toEqual([]);
  });

  it("a parent waits on a child that needs the user, marked needs you", () => {
    const wait = waitOf(
      resolve([[env1, [done("p"), childDone("c", "p", { waitPhase: "needs" })]]]),
      "p",
    );
    expect(wait?.waiting).toBe(true);
    expect(wait?.targets[0]).toMatchObject({ threadId: "c", state: "live", suffix: "needs you" });
  });

  it("follows P -> C -> G when the middle child ended by itself", () => {
    const threads = [done("p"), childDone("c", "p"), busyChild("g", "c")];
    const result = resolve([[env1, threads]]);
    expect(waitOf(result, "p")?.waiting).toBe(true);
    expect(waitOf(result, "c")?.waiting).toBe(true);
    expect(waitOf(result, "p")?.targets[0]).toMatchObject({ threadId: "c", state: "live" });
    expect(waitOf(result, "c")?.targets[0]).toMatchObject({ threadId: "g", state: "live" });
    // G finishing clears the whole chain.
    const cleared = resolve([[env1, [done("p"), childDone("c", "p"), childDone("g", "c")]]]);
    expect(waitOf(cleared, "p")?.waiting).toBe(false);
    expect(waitOf(cleared, "c")?.waiting).toBe(false);
  });

  it("adds a lineage child once next to an explicit target on the same child", () => {
    const parent = raw("p", {
      waitPhase: "waiting",
      waitingOn: [on("c", { source: "awaited_child", taskId: "task-c" })],
    });
    const wait = waitOf(resolve([[env1, [parent, busyChild("c", "p")]]]), "p");
    expect(wait?.targets).toHaveLength(1);
    expect(wait?.targets[0]).toMatchObject({ taskId: "task-c", state: "live" });
  });

  it("appends live children to a working parent without making it Waiting", () => {
    const parent = raw("p", {
      waitPhase: "working",
      waitingOn: [],
      status: "running",
      latestRunId: "run-p" as never,
      activeRunId: "run-p" as never,
      activityRunStatus: "running",
    });
    const wait = waitOf(resolve([[env1, [parent, busyChild("c", "p")]]]), "p");
    expect(wait?.waiting).toBe(false);
    expect(wait?.targets).toEqual([expect.objectContaining({ threadId: "c", state: "live" })]);
  });

  it("never resurrects a settled, archived or failed parent", () => {
    const child = busyChild("c", "p");
    const parents = {
      settled: done("p", { settledOverride: "settled" }),
      archived: done("p", { archivedAt: v2ThreadShell.updatedAt }),
      failed: done("p", { status: "failed" }),
      cancelled: done("p", { status: "cancelled" }),
    };
    for (const [name, parent] of Object.entries(parents)) {
      const wait = waitOf(resolve([[env1, [parent, child]]]), "p");
      expect(wait?.waiting, name).toBe(false);
    }
    // Settled or archived children hold nobody either.
    for (const closed of [
      busyChild("c", "p", { settledOverride: "settled" }),
      busyChild("c", "p", { archivedAt: v2ThreadShell.updatedAt }),
    ]) {
      expect(waitOf(resolve([[env1, [done("p"), closed]]]), "p")?.waiting).toBe(false);
    }
  });

  it("gives a parent from a server without wait fields no entry, and reads such a child by its lifecycle", () => {
    const oldParent = raw("p", { status: "completed", latestRunId: "run-p" as never });
    expect(waitOf(resolve([[env1, [oldParent, busyChild("c", "p")]]]), "p")).toBeUndefined();
    const { waitPhase: _phase, waitingOn: _on, ...legacyChild } = busyChild("c", "p");
    const wait = waitOf(resolve([[env1, [done("p"), legacyChild]]]), "p");
    expect(wait?.waiting).toBe(true);
    expect(wait?.targets[0]).toMatchObject({ threadId: "c", state: "live" });
  });

  it("terminates on a lineage cycle and keeps it ended without a live exit", () => {
    const a = done("a", { lineage: subagentOf("b") });
    const b = done("b", { lineage: subagentOf("a") });
    const result = resolve([[env1, [a, b]]]);
    expect(waitOf(result, "a")?.waiting).toBe(false);
    expect(waitOf(result, "b")?.waiting).toBe(false);
    // With a live child hanging off the cycle, both wait.
    const withLive = resolve([[env1, [a, b, busyChild("c", "a")]]]);
    expect(waitOf(withLive, "a")?.waiting).toBe(true);
    expect(waitOf(withLive, "b")?.waiting).toBe(true);
  });

  it("keeps a lineage wait through reconnects: unknown while disconnected, then the fresh answer", () => {
    const parent = done("p");
    const threads = [parent, busyChild("c", "p")];
    expect(waitOf(resolve([[env1, threads]]), "p")?.waiting).toBe(true);
    // Disconnected: the cached child is unknown, still waiting, and its Open has no route.
    const disconnected = waitOf(resolve([[env1, threads]], { notReady: [env1] }), "p");
    expect(disconnected?.waiting).toBe(true);
    expect(disconnected?.targets[0]).toMatchObject({ state: "unknown", suffix: "not connected" });
    // Synchronized again with the child ended, or gone from the snapshot: the parent clears.
    expect(waitOf(resolve([[env1, [parent, childDone("c", "p")]]]), "p")?.waiting).toBe(false);
    expect(waitOf(resolve([[env1, [parent]]]), "p")?.waiting).toBe(false);
  });

  it("shows the sender of a child's open run waiting on it, not the lineage parent", () => {
    const sender = done("s");
    const parent = done("p");
    const child = busyChild("c", "p", { latestRunSenderThreadId: ThreadId.make("s") });
    const live = resolve([[env1, [sender, parent, child]]]);
    expect(waitOf(live, "s")?.waiting).toBe(true);
    expect(waitOf(live, "s")?.targets).toEqual([
      expect.objectContaining({ threadId: "c", source: "awaited_child", state: "live" }),
    ]);
    expect(waitOf(live, "p")?.waiting).toBe(false);
    // The run completed: neither waits; the parent does not take the ended run back.
    const ended = resolve([
      [
        env1,
        [sender, parent, childDone("c", "p", { latestRunSenderThreadId: ThreadId.make("s") })],
      ],
    ]);
    expect(waitOf(ended, "s")?.waiting).toBe(false);
    expect(waitOf(ended, "p")?.waiting).toBe(false);
    // Still needing the user after the sender's run ended: no driver, so neither waits.
    const asks = resolve([
      [
        env1,
        [
          sender,
          parent,
          childDone("c", "p", { latestRunSenderThreadId: ThreadId.make("s"), waitPhase: "needs" }),
        ],
      ],
    ]);
    expect(waitOf(asks, "s")?.waiting).toBe(false);
    expect(waitOf(asks, "p")?.waiting).toBe(false);
  });

  it("keeps the lineage rule for a parent sender, a self sender or no sender field", () => {
    for (const latestRunSenderThreadId of [ThreadId.make("p"), ThreadId.make("c"), null]) {
      const child = busyChild("c", "p", { latestRunSenderThreadId });
      expect(waitOf(resolve([[env1, [done("p"), child]]]), "p")?.waiting).toBe(true);
    }
    // A completed, unsettled sender still shows its live child: the child's run decides.
    const sender = done("s");
    const child = busyChild("c", "p", { latestRunSenderThreadId: ThreadId.make("s") });
    expect(waitOf(resolve([[env1, [sender, done("p"), child]]]), "s")?.waiting).toBe(true);
  });

  it("never makes the sender of a top-level thread wait", () => {
    const target = raw("t", {
      waitPhase: "working",
      waitingOn: [],
      status: "running",
      latestRunId: "run-t" as never,
      activityRunStatus: "running",
      latestRunSenderThreadId: ThreadId.make("s"),
    });
    expect(waitOf(resolve([[env1, [done("s"), target]]]), "s")?.waiting).toBe(false);
  });

  it("stays linear on one parent of 5k children and a 1k-deep chain among 10k shells", () => {
    const threads: Array<OrchestrationV2ThreadShell> = [done("root")];
    let edges = 0;
    for (let index = 0; index < 5000; index++) {
      threads.push(
        index === 4999 ? busyChild(`w${index}`, "root") : childDone(`w${index}`, "root"),
      );
      edges++;
    }
    threads.push(done("chain0"));
    for (let depth = 1; depth < 1000; depth++) {
      threads.push(
        depth === 999
          ? busyChild(`chain${depth}`, `chain${depth - 1}`)
          : childDone(`chain${depth}`, `chain${depth - 1}`),
      );
      edges++;
    }
    while (threads.length < 10_000) threads.push(done(`quiet${threads.length}`));
    const stats: ThreadWaitResolveStats = { ops: 0 };
    const result = resolve([[env1, threads]], { stats });
    expect(waitOf(result, "root")?.waiting).toBe(true);
    expect(waitOf(result, "root")?.targets).toEqual([
      expect.objectContaining({ threadId: "w4999", state: "live" }),
    ]);
    expect(waitOf(result, "chain0")?.waiting).toBe(true);
    expect(stats.ops).toBeLessThanOrEqual(4 * (threads.length + edges));
  });
});

describe("resolveThreadWaits pull request watch targets (WP A1)", () => {
  it("carries the watched link's URL so Open can show the pull request", () => {
    const link = {
      host: "GitHub.com",
      repository: "Owner/Repo",
      number: 42,
      url: "https://github.com/Owner/Repo/pull/42",
      source: "manual" as const,
      linkedAt: "2026-11-22T10:00:00.000Z",
      snapshot: null,
      stack: null,
    };
    const waiter = raw("a", {
      waitPhase: "waiting",
      pullRequests: [link],
      waitingOn: [
        on(null, {
          source: "awaited_child",
          title: "PR #42 checks",
          taskId: "pull-request-watch:github.com/owner/repo#42",
        }),
        on(null, {
          source: "awaited_child",
          title: "PR #9 checks",
          taskId: "pull-request-watch:github.com/owner/repo#9",
        }),
      ],
    });
    const wait = waitOf(resolve([[env1, [waiter]]]), "a");
    expect(wait?.waiting).toBe(true);
    expect(wait?.targets[0]).toMatchObject({
      title: "PR #42 checks",
      state: "live",
      pullRequestUrl: "https://github.com/Owner/Repo/pull/42",
    });
    // No matching link: no URL, so Open falls back to the waiter.
    expect(wait?.targets[1]).not.toHaveProperty("pullRequestUrl");
  });
});

describe("resolveThreadWaits target kinds", () => {
  it("names each target's kind from its source, thread and the waiter's roster", () => {
    const waiter = raw("a", {
      waitPhase: "waiting",
      pendingBackgroundTasks: [
        { taskId: "cmd-1", kind: "command", awaited: true, description: "vp test" },
        { taskId: "mon-1", kind: "monitor", awaited: true },
        { taskId: "task-1", kind: "background_task", awaited: true },
        { taskId: "native-1", kind: "subagent" },
      ],
      waitingOn: [
        on("t", { title: "Review" }),
        on("c", { source: "subagent", title: "Build" }),
        on("g", { source: "awaited_child", title: "Explore" }),
        on(null, { source: "awaited_child", title: "vp test", taskId: "cmd-1" }),
        on(null, { source: "awaited_child", title: "monitor", taskId: "mon-1" }),
        on(null, { source: "awaited_child", title: "background task", taskId: "task-1" }),
        on(null, { source: "awaited_child", title: "Native", taskId: "native-1" }),
        on(null, { source: "awaited_child", title: "Gone", taskId: "unrostered" }),
        on(null, {
          source: "awaited_child",
          title: "PR #12 checks",
          taskId: "pull-request-watch:github.com/owner/repo#12",
        }),
        on(null, { source: "delegate_wait", title: "Delegate" }),
      ],
    });
    const wait = waitOf(
      resolve([
        [env1, [waiter, phase("t", "working"), phase("c", "working"), phase("g", "working")]],
      ]),
      "a",
    );
    expect(wait?.targets.map((target) => [target.title, target.kind])).toEqual([
      ["Review", "thread"],
      ["Build", "subagent"],
      ["Explore", "subagent"],
      ["vp test", "command"],
      ["monitor", "monitor"],
      ["background task", "background_task"],
      ["Native", "subagent"],
      ["Gone", "background_task"],
      ["PR #12 checks", "pull_request"],
      ["Delegate", "thread"],
    ]);
  });
});
