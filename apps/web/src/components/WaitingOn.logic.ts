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

/**
 * The targets that still run, whether or not the thread itself is waiting: what a running thread
 * also has going ("Also running").
 */
export function liveWaitTargets(wait: ResolvedThreadWait | undefined): ResolvedWaitTarget[] {
  if (wait === undefined) return [];
  return wait.targets.filter((target) => target.state !== "ended");
}

export type WaitTargetRoute =
  | {
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      /** Set when the target lives in the waiter's own timeline: the row to reveal. */
      readonly item?: string;
    }
  | {
      /** A watched pull request: Open shows it in the pull request view. */
      readonly pullRequestUrl: string;
    };

/**
 * Where Open goes: the target thread, a watched pull request in the pull request view, or for
 * work without its own thread the waiter's timeline at that item (the waiter itself when the item
 * is unknown). Null while the target's environment is not connected.
 */
export function waitTargetRoute(
  waiter: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
  target: ResolvedWaitTarget,
): WaitTargetRoute | null {
  if (target.state === "unknown") return null;
  if (target.threadId !== null) {
    return { environmentId: target.environmentId, threadId: target.threadId };
  }
  if (target.pullRequestUrl !== undefined) return { pullRequestUrl: target.pullRequestUrl };
  return {
    environmentId: waiter.environmentId,
    threadId: waiter.threadId,
    ...(target.itemId === undefined ? {} : { item: target.itemId }),
  };
}
