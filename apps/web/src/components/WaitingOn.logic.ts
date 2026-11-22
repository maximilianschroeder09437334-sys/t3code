import type {
  ResolvedThreadWait,
  ResolvedWaitTarget,
} from "@t3tools/client-runtime/state/thread-wait";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

/** The targets still keeping a thread waiting; ended ones are not listed. */
export function openWaitTargets(wait: ResolvedThreadWait | undefined): ResolvedWaitTarget[] {
  if (wait === undefined || !wait.waiting) return [];
  return wait.targets.filter((target) => target.state !== "ended");
}

export interface WaitTargetRoute {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Set when the target lives in the waiter's own timeline: the row to reveal. */
  readonly item?: string;
}

/**
 * Where Open goes: the target thread, or for a subagent without its own thread the waiter's
 * timeline at that item. Null while the target's environment is not connected.
 */
export function waitTargetRoute(
  waiter: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
  target: ResolvedWaitTarget,
): WaitTargetRoute | null {
  if (target.state === "unknown") return null;
  if (target.threadId !== null) {
    return { environmentId: target.environmentId, threadId: target.threadId };
  }
  return {
    environmentId: waiter.environmentId,
    threadId: waiter.threadId,
    ...(target.itemId === undefined ? {} : { item: target.itemId }),
  };
}
