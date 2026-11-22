import { describe, expect, it } from "vite-plus/test";
import type { ThreadId } from "@t3tools/contracts";

import {
  backgroundWorkHoldsCompletion,
  derivePendingBackgroundWork,
  isPullRequestWatchTask,
} from "./orchestrationV2PendingBackgroundWork.ts";
import {
  deriveThreadWaitState,
  waitEndedByClosure,
  waitEndedByFailedRun,
  waitEndsByLifecycle,
  type ThreadWaitStateInput,
  type WaitStateTurnItem,
} from "./orchestrationV2WaitState.ts";

const RUN = "run-1" as never;
const base: ThreadWaitStateInput = {
  activeRun: null,
  hasActivityRun: false,
  latestRunStatus: "completed",
  turnItems: [],
  pendingBackgroundTasks: [],
  providerSessionStatus: "ready",
  reportWait: null,
  handoffSuccessorThreadId: null,
  needsYou: false,
  archivedOrDeleted: false,
  settled: false,
};
const running: Partial<ThreadWaitStateInput> = {
  activeRun: { id: RUN, status: "running" },
  hasActivityRun: true,
  latestRunStatus: "running",
};
const item = (overrides: Partial<WaitStateTurnItem>): WaitStateTurnItem => ({
  id: "item-1",
  type: "dynamic_tool",
  status: "running",
  runId: RUN,
  ...overrides,
});
const threadWait = (threadId: string, environmentId?: string, status = "running") =>
  item({
    id: `wait-${threadId}`,
    toolName: "mcp__t3-code__t3_thread_wait",
    input: { threadId, ...(environmentId ? { environmentId } : {}) },
    status: status as never,
  });
const derive = (overrides: Partial<ThreadWaitStateInput>) =>
  deriveThreadWaitState({ ...base, ...overrides });

describe("deriveThreadWaitState sources", () => {
  it("(a) an executing thread wait targets its thread, with a same-environment title", () => {
    const state = derive({
      ...running,
      turnItems: [threadWait("child")],
      titleOf: (id) => (id === "child" ? "Child thread" : null),
    });
    expect(state.waitPhase).toBe("waiting");
    expect(state.waitingOn).toEqual([
      {
        source: "thread_wait",
        environmentId: null,
        threadId: "child",
        title: "Child thread",
        itemId: "wait-child",
      },
    ]);
  });

  it("(a) a cross-environment wait keeps its environment and no local title", () => {
    const state = derive({
      ...running,
      turnItems: [threadWait("remote", "env-2")],
      titleOf: () => "wrong",
    });
    expect(state.waitingOn[0]).toMatchObject({ environmentId: "env-2", title: null });
  });

  it("(a) a timed-out wait completes and drops its source", () => {
    const state = derive({ ...running, turnItems: [threadWait("child", undefined, "completed")] });
    expect(state.waitingOn).toEqual([]);
    expect(state.waitPhase).toBe("working");
  });

  it("(b) a delegate wait targets its executing app-owned child", () => {
    const state = derive({
      ...running,
      turnItems: [
        item({ toolName: "delegate_task", input: { mode: "wait", title: "Review" } }),
        item({
          id: "sub-1",
          type: "subagent",
          origin: "app_owned",
          childThreadId: "child" as ThreadId,
          prompt: "Review it",
        }),
      ],
    });
    expect(state.waitPhase).toBe("waiting");
    expect(state.waitingOn).toEqual([
      expect.objectContaining({ source: "delegate_wait", threadId: "child", itemId: "sub-1" }),
    ]);
  });

  it("(b) a delegate wait whose child does not exist yet is a starting null-thread target", () => {
    const state = derive({
      ...running,
      turnItems: [item({ toolName: "delegate_task", input: { mode: "wait", title: "Review" } })],
    });
    expect(state.waitPhase).toBe("waiting");
    expect(state.waitingOn).toEqual([
      expect.objectContaining({ source: "delegate_wait", threadId: null, title: "Review" }),
    ]);
  });

  it("(b) an ended app-owned row gives no child target", () => {
    const state = derive({
      ...running,
      turnItems: [
        item({ toolName: "delegate_task", input: { mode: "wait" } }),
        item({
          id: "sub-1",
          type: "subagent",
          origin: "app_owned",
          childThreadId: "child" as ThreadId,
          status: "completed",
        }),
      ],
    });
    expect(state.waitingOn.every((target) => target.threadId === null)).toBe(true);
  });

  it("(c) an executing native subagent without a thread is a null-thread target", () => {
    const state = derive({
      ...running,
      turnItems: [
        item({
          id: "agent-1",
          type: "subagent",
          origin: "provider_native",
          childThreadId: null,
          prompt: "Explore the repo\nmore",
          nativeItemRef: { nativeId: "toolu_1" },
        }),
      ],
    });
    expect(state.waitPhase).toBe("waiting");
    expect(state.waitingOn).toEqual([
      {
        source: "subagent",
        environmentId: null,
        threadId: null,
        title: "Explore the repo",
        itemId: "agent-1",
        taskId: "toolu_1",
      },
    ]);
  });

  it("(c) a completed native subagent gives no target", () => {
    const state = derive({
      ...running,
      turnItems: [item({ type: "subagent", origin: "provider_native", status: "completed" })],
    });
    expect(state.waitingOn).toEqual([]);
  });

  it("(d) a roster subagent with a child always counts", () => {
    const state = derive({
      providerSessionStatus: "stopped",
      pendingBackgroundTasks: [
        { taskId: "t1", kind: "subagent", childThreadId: "child" as ThreadId, awaited: true },
      ],
    });
    expect(state.waitPhase).toBe("waiting");
    expect(state.waitingOn[0]).toMatchObject({ source: "awaited_child", threadId: "child" });
  });

  it.each([
    ["stopped", false],
    ["error", false],
    [null, false],
    ["ready", true],
    ["running", true],
  ] as const)("(d) a roster subagent without a child, session %s, counts: %s", (status, counts) => {
    const state = derive({
      providerSessionStatus: status,
      pendingBackgroundTasks: [{ taskId: "t1", kind: "subagent", description: "Explore" }],
    });
    expect(state.waitingOn.length > 0).toBe(counts);
    expect(state.waitPhase).toBe(counts ? "waiting" : "ended");
  });

  it("(e) a report WAIT counts only after a completed run with no activity", () => {
    const reportWait = { title: "Child", environmentId: "env-1", threadId: "child" };
    expect(derive({ reportWait }).waitingOn).toEqual([
      { source: "report_wait", environmentId: "env-1", threadId: "child", title: "Child" },
    ]);
    expect(derive({ reportWait, ...running }).waitingOn).toEqual([]);
  });

  it("(f) a handoff successor counts after a completed run", () => {
    const state = derive({
      handoffSuccessorThreadId: "next" as ThreadId,
      titleOf: () => "Successor",
    });
    expect(state.waitingOn).toEqual([
      { source: "handoff", environmentId: null, threadId: "next", title: "Successor" },
    ]);
  });
});

describe("deriveThreadWaitState phase", () => {
  const stale = {
    pendingBackgroundTasks: [
      { taskId: "t1", kind: "subagent" as const, childThreadId: "child" as ThreadId },
    ],
    reportWait: { title: "C", environmentId: "env-1", threadId: "c" },
    handoffSuccessorThreadId: "next" as ThreadId,
  };

  it.each(["failed", "cancelled", "interrupted"] as const)(
    "a %s run with a stale roster, WAIT or handoff marker ends",
    (latestRunStatus) => {
      expect(derive({ ...stale, latestRunStatus }).waitPhase).toBe("ended");
    },
  );

  it("archived, deleted or settled ends whatever else holds", () => {
    expect(derive({ ...stale, archivedOrDeleted: true }).waitPhase).toBe("ended");
    expect(derive({ ...stale, settled: true }).waitPhase).toBe("ended");
  });

  it("needs-you wins over waiting", () => {
    expect(derive({ ...stale, needsYou: true }).waitPhase).toBe("needs");
  });

  it("a concurrent command beside a wait is working", () => {
    const state = derive({
      ...running,
      turnItems: [threadWait("child"), item({ id: "cmd", type: "command_execution" })],
    });
    expect(state.waitPhase).toBe("working");
  });

  it("an active run without executing waits is working; an idle thread is ended", () => {
    expect(derive(running).waitPhase).toBe("working");
    expect(derive({}).waitPhase).toBe("ended");
  });

  it("an item from another run never counts", () => {
    const state = derive({ ...running, turnItems: [{ ...threadWait("x"), runId: "old" }] });
    expect(state.waitingOn).toEqual([]);
  });
});

type RosterTask = ThreadWaitStateInput["pendingBackgroundTasks"][number];
type PullRequestLink = NonNullable<
  Parameters<typeof derivePendingBackgroundWork>[0]["pullRequests"]
>[number];

/** A watched link; its roster entry comes from the real derivation, so the test follows its rules. */
const watchedLink = (
  // Loose so a test can drop the watch with `watch: undefined`.
  overrides: Partial<Record<keyof PullRequestLink, unknown>> = {},
  watch: { readonly checksPending?: boolean } = { checksPending: true },
): PullRequestLink =>
  ({
    host: "github.com",
    repository: "Owner/Repo",
    number: 42,
    url: "https://github.com/Owner/Repo/pull/42",
    source: "manual",
    snapshot: { state: "open" },
    watch: {
      startedAt: "2026-11-22T10:00:00.000Z",
      headSha: null,
      failedChecks: [],
      passed: false,
      passedChecks: [],
      remarksThrough: "2026-11-22T10:00:00.000Z",
      remarkIds: [],
      conflicting: false,
      wakes: 0,
      ...watch,
    },
    ...overrides,
  }) as PullRequestLink;
const watchRoster = (link: PullRequestLink | null): ReadonlyArray<RosterTask> =>
  derivePendingBackgroundWork({
    latestRun: { id: RUN, ordinal: 1, status: "completed" },
    providerThreads: [],
    turnItems: [],
    runs: [],
    pullRequests: link === null ? [] : [link],
  });

describe("deriveThreadWaitState roster classes (WP A1)", () => {
  const awaitedCommand: RosterTask = {
    taskId: "bwngue5o4",
    kind: "command",
    awaited: true,
    description: "vp test --run apps/server\n--reporter dot",
  };

  it("an awaited command after a completed run, session live, is one titled waiting target", () => {
    const state = derive({
      providerSessionStatus: "ready",
      pendingBackgroundTasks: [awaitedCommand],
      turnItems: [
        item({
          id: "item-bash",
          type: "command_execution",
          status: "running",
          nativeItemRef: { nativeId: "bwngue5o4" },
        }),
      ],
    });
    expect(state.waitPhase).toBe("waiting");
    expect(state.waitingOn).toEqual([
      {
        source: "awaited_child",
        environmentId: null,
        threadId: null,
        title: "vp test --run apps/server",
        taskId: "bwngue5o4",
        itemId: "item-bash",
      },
    ]);
  });

  it("an unawaited command (a dev server left running) holds nothing", () => {
    const { awaited: _awaited, ...devServer } = awaitedCommand;
    const state = derive({ pendingBackgroundTasks: [devServer] });
    expect(state.waitingOn).toEqual([]);
    expect(state.waitPhase).toBe("ended");
  });

  it("an awaited monitor waits; a roster id never matches a finished item", () => {
    const state = derive({
      pendingBackgroundTasks: [
        { taskId: "mon-1", kind: "monitor", awaited: true, description: "tail build.log" },
      ],
      turnItems: [
        item({
          id: "done",
          type: "command_execution",
          status: "completed",
          nativeItemRef: { nativeId: "mon-1" },
        }),
      ],
    });
    expect(state.waitPhase).toBe("waiting");
    expect(state.waitingOn).toEqual([
      expect.objectContaining({ title: "tail build.log", taskId: "mon-1" }),
    ]);
    expect(state.waitingOn[0]).not.toHaveProperty("itemId");
  });

  it("a roster task's native item id finds its item, and an untitled task gets its kind", () => {
    const state = derive({
      pendingBackgroundTasks: [
        { taskId: "bg-1", kind: "background_task", nativeItemId: "toolu_9" },
        { taskId: "cmd-2", kind: "command", awaited: true, command: "make build\nmore" },
        { taskId: "cmd-3", kind: "command", awaited: true },
      ],
      turnItems: [item({ id: "item-bg", nativeItemRef: { nativeId: "toolu_9" } })],
    });
    expect(state.waitingOn.map((target) => [target.title, target.itemId])).toEqual([
      ["background task", "item-bg"],
      ["make build", undefined],
      ["background command", undefined],
    ]);
  });

  it.each(["stopped", "error", null] as const)(
    "awaited provider work with session %s died with its process and ends",
    (providerSessionStatus) => {
      const state = derive({ providerSessionStatus, pendingBackgroundTasks: [awaitedCommand] });
      expect(state.waitingOn).toEqual([]);
      expect(state.waitPhase).toBe("ended");
    },
  );

  it.each([
    ["stopped", true],
    ["error", true],
    [null, true],
    ["ready", true],
    ["stopped", undefined],
    [null, undefined],
  ] as const)(
    "a PR watch under session %s with checks pending %s waits on PR #n checks",
    (providerSessionStatus, checksPending) => {
      const roster = watchRoster(
        watchedLink({}, checksPending === undefined ? {} : { checksPending }),
      );
      const state = derive({ providerSessionStatus, pendingBackgroundTasks: roster });
      expect(state.waitPhase).toBe("waiting");
      expect(state.waitingOn).toEqual([
        {
          source: "awaited_child",
          environmentId: null,
          threadId: null,
          title: "PR #42 checks",
          taskId: "pull-request-watch:github.com/owner/repo#42",
        },
      ]);
    },
  );

  it.each([
    ["checks complete", watchedLink({}, { checksPending: false })],
    ["merged", watchedLink({ snapshot: { state: "merged" } })],
    ["stack-dismissed", watchedLink({ source: "stack-dismissed" })],
    ["unwatched", watchedLink({ watch: undefined })],
    ["link removed", null],
  ] as const)("a PR watch whose %s holds nothing", (_name, link) => {
    const state = derive({
      providerSessionStatus: null,
      pendingBackgroundTasks: watchRoster(link),
    });
    expect(state.waitingOn).toEqual([]);
    expect(state.waitPhase).toBe("ended");
  });

  it("settled, archived and failed-latest-run threads with a pending PR watch end", () => {
    const pendingBackgroundTasks = watchRoster(watchedLink());
    expect(derive({ pendingBackgroundTasks, settled: true }).waitPhase).toBe("ended");
    expect(derive({ pendingBackgroundTasks, archivedOrDeleted: true }).waitPhase).toBe("ended");
    for (const latestRunStatus of ["failed", "cancelled", "interrupted"] as const) {
      expect(derive({ pendingBackgroundTasks, latestRunStatus }).waitPhase, latestRunStatus).toBe(
        "ended",
      );
    }
  });

  it("keeps the baseline order: needs-you after closure, before a failed run", () => {
    const pendingBackgroundTasks = watchRoster(watchedLink());
    // A failed thread that still asks the user stays "needs", as on 188a8db5.
    expect(
      derive({ pendingBackgroundTasks, latestRunStatus: "failed", needsYou: true }).waitPhase,
    ).toBe("needs");
    expect(derive({ pendingBackgroundTasks, settled: true, needsYou: true }).waitPhase).toBe(
      "ended",
    );
    // An open activity run keeps a failed latest run from ending the wait.
    expect(
      derive({ pendingBackgroundTasks, latestRunStatus: "failed", hasActivityRun: true })
        .waitPhase,
    ).toBe("waiting");
  });
});

describe("waitEndsByLifecycle", () => {
  const lifecycle = {
    archivedOrDeleted: false,
    settled: false,
    latestRunStatus: "completed",
    hasActivityRun: false,
  };

  it("ends on closure or on a failed run without activity, nothing else", () => {
    expect(waitEndsByLifecycle(lifecycle)).toBe(false);
    expect(waitEndsByLifecycle({ ...lifecycle, settled: true })).toBe(true);
    expect(waitEndsByLifecycle({ ...lifecycle, archivedOrDeleted: true })).toBe(true);
    expect(waitEndsByLifecycle({ ...lifecycle, latestRunStatus: "failed" })).toBe(true);
    expect(
      waitEndsByLifecycle({ ...lifecycle, latestRunStatus: "failed", hasActivityRun: true }),
    ).toBe(false);
    expect(waitEndedByClosure({ ...lifecycle, settled: true })).toBe(true);
    expect(waitEndedByFailedRun({ ...lifecycle, latestRunStatus: "interrupted" })).toBe(true);
  });
});

describe("deriveThreadWaitState never parks a live hold at idle without a target", () => {
  const pool: ReadonlyArray<RosterTask> = [
    { taskId: "s1", kind: "subagent", childThreadId: "child" as ThreadId },
    { taskId: "s2", kind: "subagent", description: "Explore" },
    { taskId: "c1", kind: "command", awaited: true, command: "vp test" },
    { taskId: "c2", kind: "command", description: "vp dev" },
    { taskId: "m1", kind: "monitor", awaited: true },
    { taskId: "m2", kind: "monitor" },
    { taskId: "b1", kind: "background_task" },
    watchRoster(watchedLink())[0]!,
    watchRoster(watchedLink({ number: 7 }, { checksPending: false }))[0]!,
  ];
  const sessions = ["starting", "ready", "running", "waiting", "stopped", "error", null] as const;
  const statuses = ["completed", "failed", "cancelled", "interrupted", "idle"] as const;
  const closures = [
    [false, false],
    [true, false],
    [false, true],
  ] as const;

  it("waits with a titled target whenever the client parks at idle on a hold live by its class", () => {
    let checked = 0;
    for (let first = 0; first < pool.length; first++) {
      for (let second = first; second < pool.length; second++) {
        const tasks = first === second ? [pool[first]!] : [pool[first]!, pool[second]!];
        for (const providerSessionStatus of sessions) {
          for (const latestRunStatus of statuses) {
            for (const [settled, archivedOrDeleted] of closures) {
              const state = derive({
                providerSessionStatus,
                latestRunStatus,
                settled,
                archivedOrDeleted,
                pendingBackgroundTasks: tasks,
              });
              const label = [
                tasks.map((task) => task.taskId).join("+"),
                providerSessionStatus,
                latestRunStatus,
                `settled=${settled}`,
                `archived=${archivedOrDeleted}`,
              ].join(" ");
              const sessionLive =
                providerSessionStatus !== null &&
                providerSessionStatus !== "stopped" &&
                providerSessionStatus !== "error";
              // models.ts shellRuntime parks the runtime at idle on this, unless the run failed.
              const parksAtIdle =
                backgroundWorkHoldsCompletion(tasks) && latestRunStatus !== "failed";
              const liveByClass = tasks.some((task) =>
                task.kind === "subagent" && task.childThreadId !== undefined
                  ? true
                  : isPullRequestWatchTask(task)
                    ? task.awaited === true
                    : sessionLive && backgroundWorkHoldsCompletion([task]),
              );
              const endedByPrecedence = waitEndsByLifecycle({
                archivedOrDeleted,
                settled,
                latestRunStatus,
                hasActivityRun: false,
              });
              if (parksAtIdle && liveByClass && !endedByPrecedence) {
                checked++;
                expect(state.waitPhase, label).toBe("waiting");
                expect(state.waitingOn.length, label).toBeGreaterThan(0);
              }
              // Never a Waiting phase without a target, and never an untitled thread-less target
              // (a child's title comes from its own shell on the client).
              if (state.waitPhase === "waiting") {
                expect(state.waitingOn.length, label).toBeGreaterThan(0);
              }
              for (const target of state.waitingOn) {
                if (target.threadId !== null) continue;
                expect(target.title?.trim() ?? "", label).not.toBe("");
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});
