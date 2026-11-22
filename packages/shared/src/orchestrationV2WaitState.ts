import type {
  EnvironmentId,
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderSession,
  OrchestrationV2Run,
  OrchestrationV2ShellThreadStatus,
  OrchestrationV2TurnItem,
  OrchestrationV2WaitPhase,
  OrchestrationV2WaitTarget,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

import {
  backgroundWorkHoldsCompletion,
  isPullRequestWatchTask,
} from "./orchestrationV2PendingBackgroundWork.ts";
import { resolveT3McpToolId } from "./t3McpToolPresentation.ts";

// Same execution set as deriveBlockedOnThreadWait: work that keeps a run busy.
const EXECUTION_TURN_ITEM_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  "command_execution",
  "dynamic_tool",
  "subagent",
  "file_change",
  "file_search",
  "web_search",
  "compaction",
]);

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set<OrchestrationV2ShellThreadStatus>([
  "failed",
  "cancelled",
  "interrupted",
]);

// Turn items a roster task can come from; the same set both shell builders read as pending work.
const ROSTER_TURN_ITEM_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  "command_execution",
  "dynamic_tool",
  "subagent",
]);

const LIVE_SESSION_STATUSES = new Set<OrchestrationV2ProviderSession["status"]>([
  "starting",
  "ready",
  "running",
  "waiting",
]);

/** The turn item fields the wait derivation reads; both shell builders can supply them. */
export type WaitStateTurnItem = {
  readonly id: TurnItemId | string;
  readonly type: OrchestrationV2TurnItem["type"];
  readonly status: OrchestrationV2TurnItem["status"];
  readonly runId?: OrchestrationV2Run["id"] | string | null | undefined;
  readonly title?: string | null | undefined;
  readonly toolName?: string | null | undefined;
  readonly input?: unknown;
  readonly origin?: "provider_native" | "app_owned" | undefined;
  readonly childThreadId?: ThreadId | null | undefined;
  readonly prompt?: string | undefined;
  readonly nativeItemRef?: { readonly nativeId: string | null } | null | undefined;
};

export interface ThreadWaitStateInput {
  /** The newest preparing/starting/running run. */
  readonly activeRun: Pick<OrchestrationV2Run, "id" | "status"> | null;
  /** Any activity run (including `waiting`) is still open. */
  readonly hasActivityRun: boolean;
  readonly latestRunStatus: OrchestrationV2ShellThreadStatus;
  /** Turn items of this thread; only executing ones count. */
  readonly turnItems: ReadonlyArray<WaitStateTurnItem>;
  readonly pendingBackgroundTasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly providerSessionStatus: OrchestrationV2ProviderSession["status"] | null;
  /** The parsed `T3: WAIT on` line of the latest completed report, when it is current. */
  readonly reportWait: {
    readonly title: string;
    readonly environmentId: string;
    readonly threadId: string;
  } | null;
  readonly handoffSuccessorThreadId: ThreadId | null;
  readonly needsYou: boolean;
  readonly archivedOrDeleted: boolean;
  readonly settled: boolean;
  /** Titles of threads in this environment, when the caller has them. */
  readonly titleOf?: (threadId: ThreadId) => string | null;
}

export interface ThreadWaitState {
  readonly waitingOn: ReadonlyArray<OrchestrationV2WaitTarget>;
  readonly waitPhase: OrchestrationV2WaitPhase;
}

const isExecuting = (status: OrchestrationV2TurnItem["status"]) =>
  status === "running" || status === "waiting";

function waitToolKind(item: WaitStateTurnItem): "thread_wait" | "delegate_wait" | null {
  if (item.type !== "dynamic_tool" || item.toolName == null) return null;
  const tool = resolveT3McpToolId(item.toolName);
  if (tool === "t3_thread_wait") return "thread_wait";
  if (
    tool === "delegate_task" &&
    Predicate.isObject(item.input) &&
    Reflect.get(item.input, "mode") === "wait"
  ) {
    return "delegate_wait";
  }
  return null;
}

function stringField(value: unknown, key: string): string | null {
  if (!Predicate.isObject(value)) return null;
  const field = Reflect.get(value, key);
  return typeof field === "string" && field.trim().length > 0 ? field.trim() : null;
}

/** The lifecycle facts that end a thread's wait whatever it still holds. */
export interface WaitLifecycleInput {
  readonly archivedOrDeleted: boolean;
  readonly settled: boolean;
  readonly latestRunStatus: string;
  /** Some activity run (including `waiting`) is open; never inferred from a parked runtime. */
  readonly hasActivityRun: boolean;
}

/** Archived, deleted or settled: ended before anything else, needs-you included. */
export function waitEndedByClosure(input: WaitLifecycleInput): boolean {
  return input.archivedOrDeleted || input.settled;
}

/** A failed, cancelled or interrupted latest run with no activity run left: stale holds end. */
export function waitEndedByFailedRun(input: WaitLifecycleInput): boolean {
  return TERMINAL_RUN_STATUSES.has(input.latestRunStatus) && !input.hasActivityRun;
}

/**
 * Whether a thread's lifecycle alone ends its wait. The server's phase checks needs-you between
 * the two parts; a client that only promotes `ended` shells can use the whole predicate.
 */
export function waitEndsByLifecycle(input: WaitLifecycleInput): boolean {
  return waitEndedByClosure(input) || waitEndedByFailedRun(input);
}

const PULL_REQUEST_NUMBER = /#(\d+)$/u;

/** "PR #<n> checks" from a watch's roster id, which ends in the link's number. */
function pullRequestWatchTitle(taskId: string): string {
  const number = PULL_REQUEST_NUMBER.exec(taskId)?.[1];
  return number === undefined ? "PR checks" : `PR #${number} checks`;
}

function rosterKindLabel(kind: OrchestrationV2PendingBackgroundTask["kind"]): string {
  switch (kind) {
    case "command":
      return "background command";
    case "monitor":
      return "monitor";
    case "background_task":
      return "background task";
    case "subagent":
      return "a subagent";
  }
}

function shortTitle(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  const firstLine = trimmed.split(/\r?\n/u, 1)[0]!.trim();
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
}

/**
 * What a thread waits on and its own wait phase, from its own projection only. Clients join the
 * phases along `waitingOn`, so a target that ends clears its waiters without re-projecting them.
 */
export function deriveThreadWaitState(input: ThreadWaitStateInput): ThreadWaitState {
  const titleOf = (threadId: ThreadId | null) =>
    threadId === null ? null : (input.titleOf?.(threadId) ?? null);
  const targets: Array<OrchestrationV2WaitTarget> = [];
  const seen = new Set<string>();
  const push = (target: OrchestrationV2WaitTarget) => {
    const key =
      target.threadId !== null
        ? `thread:${target.environmentId ?? ""}:${target.threadId}`
        : `item:${target.itemId ?? target.taskId ?? targets.length}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push(target);
  };

  let hasOtherWork = false;
  const activeRun = input.activeRun?.status === "running" ? input.activeRun : null;
  if (activeRun !== null) {
    const executing = input.turnItems.filter(
      (item) =>
        item.runId != null &&
        String(item.runId) === String(activeRun.id) &&
        EXECUTION_TURN_ITEM_TYPES.has(item.type) &&
        isExecuting(item.status),
    );
    const appOwnedChildren = executing.filter(
      (item) => item.type === "subagent" && item.origin === "app_owned",
    );
    for (const item of executing) {
      const waitKind = waitToolKind(item);
      if (waitKind === "thread_wait") {
        const threadId = stringField(item.input, "threadId") as ThreadId | null;
        if (threadId === null) continue;
        const environmentId = stringField(item.input, "environmentId") as EnvironmentId | null;
        push({
          source: "thread_wait",
          environmentId,
          threadId,
          title: environmentId === null ? titleOf(threadId) : null,
          itemId: item.id as TurnItemId,
        });
      } else if (waitKind === "delegate_wait") {
        const children = appOwnedChildren.filter((child) => child.childThreadId != null);
        if (children.length === 0) {
          push({
            source: "delegate_wait",
            environmentId: null,
            threadId: null,
            title: shortTitle(stringField(item.input, "title") ?? stringField(item.input, "task")),
            itemId: item.id as TurnItemId,
          });
        }
        for (const child of children) {
          push({
            source: "delegate_wait",
            environmentId: null,
            threadId: child.childThreadId!,
            title: titleOf(child.childThreadId!) ?? shortTitle(child.title ?? child.prompt),
            itemId: child.id as TurnItemId,
          });
        }
      } else if (item.type === "subagent") {
        if (item.origin === "app_owned") continue;
        const nativeId = item.nativeItemRef?.nativeId;
        push({
          source: "subagent",
          environmentId: null,
          threadId: item.childThreadId ?? null,
          title:
            (item.childThreadId == null ? null : titleOf(item.childThreadId)) ??
            shortTitle(item.title ?? item.prompt),
          itemId: item.id as TurnItemId,
          ...(typeof nativeId === "string" && nativeId.length > 0 ? { taskId: nativeId } : {}),
        });
      } else {
        hasOtherWork = true;
      }
    }
  }

  const sessionLive =
    input.providerSessionStatus !== null && LIVE_SESSION_STATUSES.has(input.providerSessionStatus);
  // Roster ids name their turn item by id or native id; built once, only when a roster needs it.
  let rosterItemIds: Map<string, TurnItemId> | undefined;
  const rosterItemId = (taskId: string): TurnItemId | undefined => {
    if (rosterItemIds === undefined) {
      rosterItemIds = new Map();
      for (const item of input.turnItems) {
        if (!ROSTER_TURN_ITEM_TYPES.has(item.type) || !isOrchestrationV2WorkActive(item.status)) {
          continue;
        }
        const id = item.id as TurnItemId;
        if (!rosterItemIds.has(String(item.id))) rosterItemIds.set(String(item.id), id);
        const nativeId = item.nativeItemRef?.nativeId;
        if (typeof nativeId === "string" && nativeId.length > 0 && !rosterItemIds.has(nativeId)) {
          rosterItemIds.set(nativeId, id);
        }
      }
    }
    return rosterItemIds.get(taskId);
  };
  for (const task of input.pendingBackgroundTasks) {
    const childThreadId =
      task.kind === "subagent" && "childThreadId" in task ? (task.childThreadId ?? null) : null;
    if (childThreadId !== null) {
      // Thread-backed: the child's own phase ends it, so no session gate.
      push({
        source: "awaited_child",
        environmentId: null,
        threadId: childThreadId,
        title: titleOf(childThreadId) ?? shortTitle(task.description),
        taskId: task.taskId,
        ...(task.itemId === undefined ? {} : { itemId: task.itemId }),
      });
      continue;
    }
    if (isPullRequestWatchTask(task)) {
      // Server-owned: it holds while the PR's checks run, whatever the provider session does,
      // and leaves the roster once the PR merges, is dismissed or stops being watched.
      if (task.awaited !== true) continue;
      push({
        source: "awaited_child",
        environmentId: null,
        threadId: null,
        title: pullRequestWatchTitle(task.taskId),
        taskId: task.taskId,
      });
      continue;
    }
    // Provider-native work lives in the provider process: it holds only while it holds completion
    // and the session that reports it is live, since a stopped session took it down.
    if (!sessionLive || !backgroundWorkHoldsCompletion([task])) continue;
    const itemId =
      task.itemId ??
      (task.nativeItemId === undefined ? undefined : rosterItemId(task.nativeItemId)) ??
      rosterItemId(task.taskId);
    push({
      source: "awaited_child",
      environmentId: null,
      threadId: null,
      title: shortTitle(task.description) ?? shortTitle(task.command) ?? rosterKindLabel(task.kind),
      taskId: task.taskId,
      ...(itemId === undefined ? {} : { itemId }),
    });
  }

  const latestCompleted = input.latestRunStatus === "completed";
  if (input.reportWait !== null && !input.hasActivityRun && latestCompleted) {
    push({
      source: "report_wait",
      environmentId: input.reportWait.environmentId as EnvironmentId,
      threadId: input.reportWait.threadId as ThreadId,
      title: input.reportWait.title,
    });
  }
  if (input.handoffSuccessorThreadId !== null && latestCompleted && !input.hasActivityRun) {
    push({
      source: "handoff",
      environmentId: null,
      threadId: input.handoffSuccessorThreadId,
      title: titleOf(input.handoffSuccessorThreadId),
    });
  }

  return { waitingOn: targets, waitPhase: waitPhaseFor(input, targets.length > 0, hasOtherWork) };
}

function waitPhaseFor(
  input: ThreadWaitStateInput,
  hasTargets: boolean,
  hasOtherWork: boolean,
): OrchestrationV2WaitPhase {
  if (waitEndedByClosure(input)) return "ended";
  if (input.needsYou) return "needs";
  if (waitEndedByFailedRun(input)) return "ended";
  if (hasOtherWork) return "working";
  if (hasTargets) return "waiting";
  return input.hasActivityRun ? "working" : "ended";
}
