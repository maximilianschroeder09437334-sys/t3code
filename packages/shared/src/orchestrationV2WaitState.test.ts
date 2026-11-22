import { describe, expect, it } from "vite-plus/test";
import type { ThreadId } from "@t3tools/contracts";

import {
  deriveThreadWaitState,
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
