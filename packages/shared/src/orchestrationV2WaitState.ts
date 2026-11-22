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
import * as Predicate from "effect/Predicate";

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

const TERMINAL_RUN_STATUSES = new Set<OrchestrationV2ShellThreadStatus>([
  "failed",
  "cancelled",
  "interrupted",
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
  readonly runId?: OrchestrationV2Run["id"] | string | null;
  readonly title?: string | null;
  readonly toolName?: string | null;
  readonly input?: unknown;
  readonly origin?: "provider_native" | "app_owned";
  readonly childThreadId?: ThreadId | null;
  readonly prompt?: string;
  readonly nativeItemRef?: { readonly nativeId: string | null } | null;
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
  for (const task of input.pendingBackgroundTasks) {
    if (task.kind !== "subagent") continue;
    const childThreadId = "childThreadId" in task ? (task.childThreadId ?? null) : null;
    // A roster entry without a child has nothing else to end it, so it lasts only as long as
    // the session that reports it.
    if (childThreadId === null && !sessionLive) continue;
    push({
      source: "awaited_child",
      environmentId: null,
      threadId: childThreadId,
      title: titleOf(childThreadId) ?? shortTitle(task.description),
      taskId: task.taskId,
      ...(task.itemId === undefined ? {} : { itemId: task.itemId }),
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
  if (input.archivedOrDeleted || input.settled) return "ended";
  if (input.needsYou) return "needs";
  if (TERMINAL_RUN_STATUSES.has(input.latestRunStatus) && !input.hasActivityRun) return "ended";
  if (hasOtherWork) return "working";
  if (hasTargets) return "waiting";
  return input.hasActivityRun ? "working" : "ended";
}
