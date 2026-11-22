import { resolveThreadWaits, threadWaitKey } from "@t3tools/client-runtime/state/thread-wait";
import { THREAD_STATUS_TEXT } from "@t3tools/client-runtime/state/thread-activity-announcement";
import {
  EnvironmentId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2WaitTarget,
} from "@t3tools/contracts";
import { deriveThreadWaitState } from "@t3tools/shared/orchestrationV2WaitState";
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
import {
  liveWaitTargets,
  openWaitTargets,
  waitTargetLabel,
  waitTargetRoute,
  waitTargetText,
} from "./WaitingOn.logic";

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

describe("Waiting for awaited work, PR checks and lineage children (WP A1, A2)", () => {
  const idle = { status: "idle", activeRunId: null } as never;
  const completed = {
    runId: "run-a",
    status: "completed",
    requestedAt: "2026-11-22T11:00:00.000Z",
    startedAt: "2026-11-22T11:00:00.000Z",
    completedAt: "2026-11-22T11:30:00.000Z",
    assistantMessageId: null,
  } as never;
  const roster = [
    {
      taskId: "bwngue5o4",
      kind: "command" as const,
      awaited: true as const,
      description: "vp test --run apps/server",
    },
  ];
  /** The server's wait fields for a completed thread holding this roster, from the real rule. */
  const derived = (pendingBackgroundTasks: typeof roster, providerSessionStatus = "ready") => {
    const state = deriveThreadWaitState({
      activeRun: null,
      hasActivityRun: false,
      latestRunStatus: "completed",
      turnItems: [],
      pendingBackgroundTasks,
      providerSessionStatus: providerSessionStatus as never,
      reportWait: null,
      handoffSuccessorThreadId: null,
      needsYou: false,
      archivedOrDeleted: false,
      settled: false,
    });
    return { waitPhase: state.waitPhase, waitingOn: [...state.waitingOn] };
  };

  it("reads an idle thread on an awaited command as Waiting everywhere, with Open at its row", () => {
    // The live f700bdf9 shape: run completed, the roster's awaited command parks it at idle.
    const a = thread("a", {
      runtime: idle,
      latestRun: completed,
      pendingBackgroundTasks: roster as never,
      ...derived(roster),
      waitingOn: derived(roster).waitingOn.map((target) => ({
        ...target,
        itemId: TurnItemId.make("item-bash"),
      })),
    });
    const wait = resolve([a]).get(threadWaitKey(env, a.id));
    expect(wait?.waiting).toBe(true);
    expect(resolveSidebarThreadStatus(a, wait)).toBe("waiting");
    expect(resolveSidebarRowStatus(a, wait)).toBe("waiting");
    expect(resolveThreadStatusPill({ thread: a, wait })?.label).toBe("Waiting");
    expect(homeRow([a])?.section).toBe("waiting");
    expect(formatHomeTimeLabel(a, NOW, undefined, wait)).toMatch(/^waiting /);
    const [target] = openWaitTargets(wait);
    expect(target?.title).toBe("vp test --run apps/server");
    expect(waitTargetRoute({ environmentId: env, threadId: a.id }, target!)).toEqual({
      environmentId: env,
      threadId: a.id,
      item: "item-bash",
    });
  });

  it("moves an idle Running row without a live target to done, label and section alike", () => {
    // The same roster after its session stopped: the hold died with the provider process.
    const a = thread("a", {
      runtime: idle,
      latestRun: completed,
      pendingBackgroundTasks: roster as never,
      ...derived(roster, "stopped"),
    });
    const wait = resolve([a]).get(threadWaitKey(env, a.id));
    expect(wait?.waiting).toBe(false);
    // No Waiting status or pill without a live target, though the roster still holds it.
    expect(resolveSidebarThreadStatus(a, wait)).toBe("ready");
    expect(resolveThreadStatusPill({ thread: a, wait })?.label).not.toBe("Waiting");
    const row = homeRow([a]);
    expect(row?.section).toBe("done");
    expect(formatHomeTimeLabel(a, NOW, undefined, row?.wait)).toMatch(/^done /);
  });

  it("opens a PR checks target in the pull request view, and without its link at the waiter", () => {
    const url = "https://github.com/owner/repo/pull/42";
    const a = thread("a", {
      runtime: idle,
      latestRun: completed,
      pullRequests: [
        {
          host: "github.com",
          repository: "owner/repo",
          number: 42,
          url,
          source: "manual",
          linkedAt: "2026-11-22T10:00:00.000Z",
          snapshot: null,
          stack: null,
        },
      ],
      waitPhase: "waiting",
      waitingOn: [
        on(null, {
          source: "awaited_child",
          title: "PR #42 checks",
          taskId: "pull-request-watch:github.com/owner/repo#42",
        }),
        on(null, {
          source: "awaited_child",
          title: "PR #7 checks",
          taskId: "pull-request-watch:github.com/owner/repo#7",
        }),
      ],
    });
    const wait = resolve([a]).get(threadWaitKey(env, a.id));
    const [pr, unlinked] = openWaitTargets(wait);
    expect(waitTargetRoute({ environmentId: env, threadId: a.id }, pr!)).toEqual({
      pullRequestUrl: url,
    });
    expect(waitTargetRoute({ environmentId: env, threadId: a.id }, unlinked!)).toEqual({
      environmentId: env,
      threadId: a.id,
    });
  });

  const subagentOf = (parent: string) => ({
    rootThreadId: ThreadId.make(parent),
    parentThreadId: ThreadId.make(parent),
    relationshipToParent: "subagent" as const,
  });

  it("shows a lineage-only parent Waiting on its live child on every surface, Open to the child", () => {
    const parent = thread("p", { latestRun: completed, waitPhase: "ended", waitingOn: [] });
    const child = thread("c", {
      title: "Pipeline child",
      lineage: subagentOf("p"),
      runtime: running,
      waitPhase: "working",
      waitingOn: [],
    });
    const wait = resolve([parent, child]).get(threadWaitKey(env, parent.id));
    expect(wait?.waiting).toBe(true);
    expect(resolveSidebarRowStatus(parent, wait)).toBe("waiting");
    expect(resolveThreadStatusPill({ thread: parent, wait })?.label).toBe("Waiting");
    expect(homeRow([parent, child], "p")?.section).toBe("waiting");
    const [target] = openWaitTargets(wait);
    expect(target?.title).toBe("Pipeline child");
    expect(waitTargetRoute({ environmentId: env, threadId: parent.id }, target!)).toEqual({
      environmentId: env,
      threadId: ThreadId.make("c"),
    });
    // The child finished: the parent is done again.
    const finished = thread("c", {
      lineage: subagentOf("p"),
      latestRun: completed,
      waitPhase: "ended",
      waitingOn: [],
    });
    const after = resolve([parent, finished]).get(threadWaitKey(env, parent.id));
    expect(after?.waiting).toBe(false);
    expect(resolveSidebarRowStatus(parent, after)).not.toBe("waiting");
  });

  it("lists a running parent's live child as Also running, not Waiting", () => {
    const parent = thread("p", { runtime: running, waitPhase: "working", waitingOn: [] });
    const child = thread("c", {
      lineage: subagentOf("p"),
      runtime: running,
      waitPhase: "working",
      waitingOn: [],
    });
    const row = homeRow([parent, child], "p");
    expect(row?.section).toBe("running");
    expect(row?.wait?.waiting).toBe(false);
    expect(openWaitTargets(row?.wait)).toEqual([]);
    expect(liveWaitTargets(row?.wait).map((target) => target.threadId)).toEqual([
      ThreadId.make("c"),
    ]);
  });
});

describe("waitTargetLabel", () => {
  it("names the kind before the title on every Waiting on line", () => {
    const cases = [
      [{ kind: "subagent", title: "Fix tests" }, "subagent Fix tests"],
      [{ kind: "thread", title: "Review" }, "thread Review"],
      [{ kind: "pull_request", title: "PR #12 checks" }, "PR #12 checks"],
      [{ kind: "command", title: "vp test" }, "command vp test"],
      [{ kind: "monitor", title: "Watch logs" }, "monitor Watch logs"],
      [{ kind: "background_task", title: "Sync" }, "background task Sync"],
      // Placeholder titles say nothing the kind word does not.
      [{ kind: "command", title: "background command" }, "command"],
      [{ kind: "background_task", title: "background task" }, "background task"],
      [{ kind: "subagent", title: "a subagent" }, "subagent"],
      [{ kind: "thread", title: "starting delegate" }, "thread"],
    ] as const;
    for (const [target, text] of cases) {
      expect(waitTargetText(target), text).toBe(text);
    }
    expect(waitTargetLabel({ kind: "pull_request", title: "PR #12 checks" })).toEqual({
      kind: null,
      title: "PR #12 checks",
    });
    expect(waitTargetLabel({ kind: "command", title: "background command" })).toEqual({
      kind: "command",
      title: null,
    });
  });
});
