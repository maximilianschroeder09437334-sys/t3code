import { resolveThreadWaits, threadWaitKey } from "@t3tools/client-runtime/state/thread-wait";
import { THREAD_STATUS_TEXT } from "@t3tools/client-runtime/state/thread-activity-announcement";
import {
  EnvironmentId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2WaitTarget,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture, type ThreadFixtureOverrides } from "../test-fixtures";
import type { Thread } from "../types";
import { deriveHomeRows, formatHomeTimeLabel } from "./home/Home.logic";
import {
  resolveSidebarRowStatus,
  resolveSidebarThreadStatus,
  resolveThreadStatusPill,
  resolveWindowTitleThreadStatus,
} from "./Sidebar.logic";
import { openWaitTargets, waitTargetRoute } from "./WaitingOn.logic";

const env = EnvironmentId.make("environment-test");
const remote = EnvironmentId.make("environment-remote");
const NOW = "2026-11-22T12:00:00.000Z";

const thread = (id: string, overrides: ThreadFixtureOverrides = {}): Thread =>
  makeThreadFixture({ id: ThreadId.make(id), title: id, environmentId: env, ...overrides });
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
const running = { status: "running", activeRunId: "run-a" } as never;
/** A waiter blocked in a running wait tool on `targets`. */
const waiter = (targets: OrchestrationV2WaitTarget[], overrides: ThreadFixtureOverrides = {}) =>
  thread("a", {
    runtime: running,
    blockedOnThreadWait: true,
    waitPhase: "waiting",
    waitingOn: targets,
    ...overrides,
  });

const resolve = (threads: Thread[], notReady: EnvironmentId[] = []) =>
  resolveThreadWaits({
    threads,
    environmentReady: (environmentId) => !notReady.includes(environmentId),
  });
const project = {
  environmentId: env,
  id: "project-test",
  displayName: "Project",
  archivedAt: null,
} as never;
const homeRow = (threads: Thread[], id = "a") => {
  const rows = deriveHomeRows({
    threads,
    projects: [project],
    now: NOW,
    lastVisitedAt: null,
    waits: resolve(threads),
  });
  return rows.find((row) => row.thread.id === id);
};

describe("Waiting from the resolved wait", () => {
  it("shows Waiting on every surface while the target is live", () => {
    const a = waiter([on("b")]);
    const b = thread("b", { runtime: running, waitPhase: "working", waitingOn: [] });
    const wait = resolve([a, b]).get(threadWaitKey(env, a.id));

    expect(wait?.waiting).toBe(true);
    expect(resolveSidebarThreadStatus(a, wait)).toBe("waiting");
    expect(resolveSidebarRowStatus(a, wait)).toBe("waiting");
    expect(resolveThreadStatusPill({ thread: a, wait })?.label).toBe("Waiting");
    // A blocked running wait is still this turn: the window title keeps saying Working.
    expect(resolveWindowTitleThreadStatus(a, wait)).toBe(THREAD_STATUS_TEXT.working);

    const row = homeRow([a, b]);
    expect(row?.section).toBe("waiting");
    expect(row?.wait?.waiting).toBe(true);
    expect(formatHomeTimeLabel(a, NOW, undefined, row?.wait)).toMatch(/^waiting /);

    const targets = openWaitTargets(wait);
    expect(targets.map((target) => target.title)).toEqual(["b"]);
    expect(waitTargetRoute({ environmentId: env, threadId: a.id }, targets[0]!)).toEqual({
      environmentId: env,
      threadId: ThreadId.make("b"),
    });
  });

  it("marks a target that needs you and keeps Waiting", () => {
    const a = waiter([on("b")]);
    const b = thread("b", { waitPhase: "needs", waitingOn: [] });
    const wait = resolve([a, b]).get(threadWaitKey(env, a.id));
    expect(resolveSidebarThreadStatus(a, wait)).toBe("waiting");
    expect(openWaitTargets(wait)[0]?.suffix).toBe("needs you");
  });

  const ended: Array<[string, (threads: Thread[]) => Thread[]]> = [
    ["ended", (t) => [...t, thread("b", { waitPhase: "ended", waitingOn: [] })]],
    [
      "failed (old server shell)",
      (t) => [...t, thread("b", { latestRun: { status: "failed" } as never })],
    ],
    [
      "cancelled (old server shell)",
      (t) => [...t, thread("b", { latestRun: { status: "cancelled" } as never })],
    ],
    [
      "interrupted (old server shell)",
      (t) => [...t, thread("b", { latestRun: { status: "interrupted" } as never })],
    ],
    [
      "archived",
      (t) => [...t, thread("b", { archivedAt: "2026-11-22T11:00:00.000Z", runtime: running })],
    ],
    ["gone", (t) => t],
  ];

  it.each(ended)("clears Waiting when the target is %s", (_name, withTarget) => {
    // Still inside the wait tool: an ended target leaves an ordinary running turn.
    const blocked = waiter([on("b")]);
    const blockedWait = resolve(withTarget([blocked])).get(threadWaitKey(env, blocked.id));
    expect(blockedWait?.waiting).toBe(false);
    expect(resolveSidebarThreadStatus(blocked, blockedWait)).toBe("working");
    expect(resolveThreadStatusPill({ thread: blocked, wait: blockedWait })?.label).toBe("Working");
    expect(openWaitTargets(blockedWait)).toEqual([]);

    // An idle waiter whose roster still names the child: old rules said Waiting.
    const idle = waiter([on("b", { source: "awaited_child" })], {
      runtime: { status: "idle", activeRunId: null } as never,
      blockedOnThreadWait: false,
      pendingBackgroundTasks: [
        { kind: "subagent", awaited: true, childThreadId: ThreadId.make("b") },
      ] as never,
    });
    expect(resolveSidebarThreadStatus(idle)).toBe("waiting");
    const idleWait = resolve(withTarget([idle])).get(threadWaitKey(env, idle.id));
    expect(resolveSidebarThreadStatus(idle, idleWait)).toBe("ready");
    expect(resolveThreadStatusPill({ thread: idle, wait: idleWait })?.label).not.toBe("Waiting");
    expect(homeRow(withTarget([idle]))?.section).toBe("done");
  });

  it("keeps the old rules for shells from servers without wait fields", () => {
    const a = thread("a", { runtime: running, blockedOnThreadWait: true });
    expect(resolve([a]).get(threadWaitKey(env, a.id))).toBeUndefined();
    expect(resolveSidebarThreadStatus(a)).toBe("waiting");
    expect(resolveThreadStatusPill({ thread: a })?.label).toBe("Waiting");
  });

  it("lets approvals and input outrank Waiting", () => {
    const a = waiter([on("b")], { hasPendingApprovals: true });
    const b = thread("b", { runtime: running, waitPhase: "working", waitingOn: [] });
    const wait = resolve([a, b]).get(threadWaitKey(env, a.id));
    expect(resolveSidebarThreadStatus(a, wait)).toBe("approval");
    expect(resolveThreadStatusPill({ thread: a, wait })?.label).toBe("Pending Approval");
  });

  it("opens a thread-less subagent at its row in the waiting thread", () => {
    const itemId = TurnItemId.make("item-explore");
    const a = waiter([on(null, { source: "subagent", itemId, title: "Explore" })]);
    const wait = resolve([a]).get(threadWaitKey(env, a.id));
    expect(resolveSidebarThreadStatus(a, wait)).toBe("waiting");
    const [target] = openWaitTargets(wait);
    expect(target?.title).toBe("Explore");
    expect(waitTargetRoute({ environmentId: env, threadId: a.id }, target!)).toEqual({
      environmentId: env,
      threadId: a.id,
      item: itemId,
    });
  });

  it("lists a target in an unconnected environment as not connected, with no Open route", () => {
    const a = waiter([on("b", { environmentId: remote, title: "Remote build" })]);
    const wait = resolve([a], [remote]).get(threadWaitKey(env, a.id));
    expect(resolveSidebarThreadStatus(a, wait)).toBe("waiting");
    const [target] = openWaitTargets(wait);
    expect(target).toMatchObject({ title: "Remote build", suffix: "not connected" });
    expect(waitTargetRoute({ environmentId: env, threadId: a.id }, target!)).toBeNull();
  });

  it("opens a target in another connected environment there", () => {
    const a = waiter([on("b", { environmentId: remote })]);
    const b = makeThreadFixture({
      id: ThreadId.make("b"),
      title: "Remote b",
      environmentId: remote,
      runtime: running,
      waitPhase: "working",
      waitingOn: [],
    });
    const wait = resolve([a, b]).get(threadWaitKey(env, a.id));
    const [target] = openWaitTargets(wait);
    expect(target?.title).toBe("Remote b");
    expect(waitTargetRoute({ environmentId: env, threadId: a.id }, target!)).toEqual({
      environmentId: remote,
      threadId: ThreadId.make("b"),
    });
  });
});
