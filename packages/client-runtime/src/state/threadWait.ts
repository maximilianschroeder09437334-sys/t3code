import type {
  EnvironmentId,
  OrchestrationV2WaitTarget,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";

import { type EnvironmentThreadShell, threadRuntimeIsActive } from "./models.ts";

/** The shell fields the wait resolver reads. */
export type ThreadWaitShell = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "title"
  | "archivedAt"
  | "deletedAt"
  | "settledOverride"
  | "latestRun"
  | "runtime"
  | "waitingOn"
  | "waitPhase"
>;

export type ResolvedWaitTargetState = "live" | "unknown" | "ended";

export interface ResolvedWaitTarget {
  readonly title: string;
  /** Where Open goes: the target's environment, or the waiter's for its own items. */
  readonly environmentId: EnvironmentId;
  /** Null for a target from the waiter's own projection (Open goes to the waiter's item). */
  readonly threadId: ThreadId | null;
  readonly waiterThreadId: ThreadId;
  readonly itemId?: TurnItemId;
  readonly taskId?: string;
  readonly source: OrchestrationV2WaitTarget["source"];
  readonly state: ResolvedWaitTargetState;
  readonly suffix?: "needs you" | "starting" | "not connected";
}

export interface ResolvedThreadWait {
  /** True while the thread's own phase is waiting and some target is live or unknown. */
  readonly waiting: boolean;
  readonly targets: ReadonlyArray<ResolvedWaitTarget>;
}

/** Chains deeper than this are not followed; the unexplored rest counts as still live. */
export const THREAD_WAIT_DEPTH_LIMIT = 16;

export const threadWaitKey = (environmentId: string, threadId: string) =>
  `${environmentId}\u0000${threadId}`;

/** Optional counters for tests; the resolver adds one per visited thread and per target. */
export interface ThreadWaitResolveStats {
  ops: number;
}

const TERMINAL_RUN_STATUSES = new Set(["failed", "cancelled", "interrupted"]);

/** A shell from a server without wait fields: only its own lifecycle says whether it ended. */
function legacyTargetState(shell: ThreadWaitShell): ResolvedWaitTargetState {
  if (shell.archivedAt !== null || shell.deletedAt !== null) return "ended";
  if (shell.settledOverride === "settled") return "ended";
  if (shell.latestRun !== null && TERMINAL_RUN_STATUSES.has(shell.latestRun.status)) {
    return "ended";
  }
  return threadRuntimeIsActive(shell.runtime) ? "live" : "ended";
}

function fallbackTitle(target: OrchestrationV2WaitTarget): string {
  if (target.source === "delegate_wait") return "starting delegate";
  if (target.source === "subagent" || target.source === "awaited_child") return "a subagent";
  return "a thread";
}

/**
 * Joins each waiting thread's targets with the targets' own phases across every environment.
 * One memo serves the whole call, so a recompute visits each thread and each edge at most once.
 * Only threads whose shell has `waitPhase` (new servers) get an entry.
 */
export function resolveThreadWaits(input: {
  readonly threads: Iterable<ThreadWaitShell>;
  /** True once the environment's shell snapshot is live (connected and synchronized). */
  readonly environmentReady: (environmentId: EnvironmentId) => boolean;
  readonly stats?: ThreadWaitResolveStats;
}): ReadonlyMap<string, ResolvedThreadWait> {
  const shells = new Map<string, ThreadWaitShell>();
  for (const shell of input.threads)
    shells.set(threadWaitKey(shell.environmentId, shell.id), shell);
  const memo = new Map<string, ResolvedThreadWait>();
  const onStack = new Set<string>();
  const stats = input.stats;
  const readiness = new Map<EnvironmentId, boolean>();
  const ready = (environmentId: EnvironmentId) => {
    let value = readiness.get(environmentId);
    if (value === undefined) {
      value = input.environmentReady(environmentId);
      readiness.set(environmentId, value);
    }
    return value;
  };

  const resolve = (key: string, shell: ThreadWaitShell, depth: number): ResolvedThreadWait => {
    const known = memo.get(key);
    if (known !== undefined) return known;
    if (stats) stats.ops++;
    onStack.add(key);
    const targets = (shell.waitingOn ?? []).map((target) => resolveTarget(shell, target, depth));
    onStack.delete(key);
    const resolved: ResolvedThreadWait = {
      waiting:
        shell.waitPhase === "waiting" &&
        targets.some((target) => target.state === "live" || target.state === "unknown"),
      targets,
    };
    memo.set(key, resolved);
    return resolved;
  };

  const resolveTarget = (
    waiter: ThreadWaitShell,
    target: OrchestrationV2WaitTarget,
    depth: number,
  ): ResolvedWaitTarget => {
    if (stats) stats.ops++;
    const environmentId = target.environmentId ?? waiter.environmentId;
    const base = {
      environmentId,
      threadId: target.threadId,
      waiterThreadId: waiter.id,
      source: target.source,
      ...(target.itemId === undefined ? {} : { itemId: target.itemId }),
      ...(target.taskId === undefined ? {} : { taskId: target.taskId }),
    };
    // The waiter's own projection emits these only while they run; they clear at the source.
    if (target.threadId === null) {
      return {
        ...base,
        title: target.title ?? fallbackTitle(target),
        state: "live",
        ...(target.source === "delegate_wait" ? { suffix: "starting" as const } : {}),
      };
    }
    const key = threadWaitKey(environmentId, target.threadId);
    const shell = shells.get(key);
    const title = target.title ?? shell?.title ?? fallbackTitle(target);
    if (!ready(environmentId)) {
      return { ...base, title, state: "unknown", suffix: "not connected" };
    }
    // Ready snapshots keep every waiting, working or needs-you thread, so absent means gone.
    if (shell === undefined) return { ...base, title, state: "ended" };
    switch (shell.waitPhase) {
      case undefined:
        return { ...base, title, state: legacyTargetState(shell) };
      case "working":
        return { ...base, title, state: "live" };
      case "needs":
        return { ...base, title, state: "live", suffix: "needs you" };
      case "ended":
        return { ...base, title, state: "ended" };
      case "waiting": {
        // A cycle back into the current chain cannot keep anything waiting.
        if (onStack.has(key)) return { ...base, title, state: "ended" };
        // Conservative: an unexplored deeper chain may still be live.
        if (depth + 1 >= THREAD_WAIT_DEPTH_LIMIT && !memo.has(key)) {
          return { ...base, title, state: "live" };
        }
        const nested = resolve(key, shell, depth + 1);
        return { ...base, title, state: nested.waiting ? "live" : "ended" };
      }
    }
  };

  const result = new Map<string, ResolvedThreadWait>();
  for (const [key, shell] of shells) {
    if (shell.waitPhase === undefined) continue;
    result.set(key, resolve(key, shell, 0));
  }
  return result;
}

/** Readiness from shell states: a snapshot is complete only while its stream is live. */
export function environmentReadyFromShellStatus(
  statusOf: (environmentId: EnvironmentId) => string | undefined,
): (environmentId: EnvironmentId) => boolean {
  return (environmentId) => statusOf(environmentId) === "live";
}
