import type {
  ResolvedThreadWait,
  ResolvedWaitTarget,
  WaitTargetKind,
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

const WAIT_TARGET_KIND_WORDS: Record<WaitTargetKind, string | null> = {
  subagent: "subagent",
  thread: "thread",
  command: "command",
  monitor: "monitor",
  background_task: "background task",
  // Its title already says it: "PR #12 checks".
  pull_request: null,
};

/** Titles the server or resolver use when nothing better is known; the kind word says it all. */
const PLACEHOLDER_TITLES = new Set([
  "a subagent",
  "a thread",
  "starting delegate",
  "background command",
  "monitor",
  "background task",
]);

/**
 * How a line names a target after "Waiting on": its kind word, then its title, as in
 * "subagent Fix tests", "thread Review", "PR #12 checks" or "command vp test". A placeholder title
 * leaves the kind word alone ("command", "background task").
 */
export function waitTargetLabel(target: Pick<ResolvedWaitTarget, "kind" | "title">): {
  readonly kind: string | null;
  readonly title: string | null;
} {
  const kind = WAIT_TARGET_KIND_WORDS[target.kind];
  const title = kind !== null && PLACEHOLDER_TITLES.has(target.title) ? null : target.title;
  return { kind, title };
}

/** The same as one string, for accessible names. */
export function waitTargetText(target: Pick<ResolvedWaitTarget, "kind" | "title">): string {
  const { kind, title } = waitTargetLabel(target);
  return [kind, title].filter((part) => part !== null).join(" ");
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
