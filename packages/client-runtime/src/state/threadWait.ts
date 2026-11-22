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

/**
 * A waiting chain taller than this many threads is not followed to its end: the waiter next to
 * the unexplored rest keeps counting it as live, so a long chain never clears early.
 */
export const THREAD_WAIT_DEPTH_LIMIT = 16;

export const threadWaitKey = (environmentId: string, threadId: string) =>
  `${environmentId}\u0000${threadId}`;

/** Optional counters for tests: one per visited thread, target, propagation and SCC step. */
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

type TargetBase = Omit<ResolvedWaitTarget, "state" | "suffix">;

/** A target whose state is known by itself, or one that depends on another waiting thread. */
type ClassifiedTarget =
  | {
      readonly kind: "final";
      readonly base: TargetBase;
      readonly state: ResolvedWaitTargetState;
      readonly suffix?: ResolvedWaitTarget["suffix"];
    }
  | { readonly kind: "waiting"; readonly base: TargetBase; readonly key: string };

interface TarjanFrame {
  readonly key: string;
  readonly next: ReadonlyArray<string>;
  at: number;
}

const edgeKey = (waiter: string, target: string) => `${waiter}\u0001${target}`;

/**
 * Joins each waiting thread's targets with the targets' own phases across every environment,
 * independent of shell order: waiting holds while a path through waiting threads reaches a live
 * target. Linear in shells plus edges, without recursion. Only threads whose shell has
 * `waitPhase` (new servers) get an entry.
 */
export function resolveThreadWaits(input: {
  readonly threads: Iterable<ThreadWaitShell>;
  /** True once the environment's shell snapshot is live (connected and synchronized). */
  readonly environmentReady: (environmentId: EnvironmentId) => boolean;
  readonly stats?: ThreadWaitResolveStats;
}): ReadonlyMap<string, ResolvedThreadWait> {
  const stats = input.stats;
  const count = () => {
    if (stats) stats.ops++;
  };
  const shells = new Map<string, ThreadWaitShell>();
  for (const shell of input.threads)
    shells.set(threadWaitKey(shell.environmentId, shell.id), shell);
  const readiness = new Map<EnvironmentId, boolean>();
  const ready = (environmentId: EnvironmentId) => {
    let value = readiness.get(environmentId);
    if (value === undefined) {
      value = input.environmentReady(environmentId);
      readiness.set(environmentId, value);
    }
    return value;
  };

  const classify = (
    waiter: ThreadWaitShell,
    target: OrchestrationV2WaitTarget,
  ): ClassifiedTarget => {
    count();
    const environmentId = target.environmentId ?? waiter.environmentId;
    const ids = {
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
        kind: "final",
        base: { ...ids, title: target.title ?? fallbackTitle(target) },
        state: "live",
        ...(target.source === "delegate_wait" ? { suffix: "starting" as const } : {}),
      };
    }
    const key = threadWaitKey(environmentId, target.threadId);
    const shell = shells.get(key);
    const base = { ...ids, title: target.title ?? shell?.title ?? fallbackTitle(target) };
    if (!ready(environmentId)) {
      return { kind: "final", base, state: "unknown", suffix: "not connected" };
    }
    // Ready snapshots keep every waiting, working or needs-you thread, so absent means gone.
    if (shell === undefined) return { kind: "final", base, state: "ended" };
    switch (shell.waitPhase) {
      case undefined:
        return { kind: "final", base, state: legacyTargetState(shell) };
      case "working":
        return { kind: "final", base, state: "live" };
      case "needs":
        return { kind: "final", base, state: "live", suffix: "needs you" };
      case "ended":
        return { kind: "final", base, state: "ended" };
      case "waiting":
        return { kind: "waiting", base, key };
    }
  };

  // Pass 1: classify every target once; waiting threads with a final live target are live.
  const classified = new Map<string, ReadonlyArray<ClassifiedTarget>>();
  /** Waiting thread -> the waiting threads it waits on. */
  const edges = new Map<string, Array<string>>();
  /** Waiting thread -> the waiting threads that wait on it. */
  const waitersOf = new Map<string, Array<string>>();
  const live = new Set<string>();
  const queue: Array<string> = [];
  for (const [key, shell] of shells) {
    if (shell.waitPhase === undefined) continue;
    count();
    const targets = (shell.waitingOn ?? []).map((target) => classify(shell, target));
    classified.set(key, targets);
    if (shell.waitPhase !== "waiting") continue;
    const next: Array<string> = [];
    let hasLiveExit = false;
    for (const target of targets) {
      if (target.kind === "waiting") {
        next.push(target.key);
        const waiters = waitersOf.get(target.key);
        if (waiters === undefined) waitersOf.set(target.key, [key]);
        else waiters.push(key);
      } else if (target.state === "live" || target.state === "unknown") {
        hasLiveExit = true;
      }
    }
    edges.set(key, next);
    if (hasLiveExit) {
      live.add(key);
      queue.push(key);
    }
  }

  // Pass 2: every waiting thread that reaches a live exit through waiting threads is live.
  const spread = () => {
    while (queue.length > 0) {
      const key = queue.pop()!;
      for (const waiter of waitersOf.get(key) ?? []) {
        count();
        if (live.has(waiter)) continue;
        live.add(waiter);
        queue.push(waiter);
      }
    }
  };
  spread();

  // Pass 3, the depth limit: over the waiting threads still without a live exit, an iterative
  // Tarjan gives each one its chain height (threads on the longest path down the condensed graph,
  // a cycle counting once). A target that tall counts as live for its waiter, which then spreads
  // like pass 2. Its waiters are then exactly the ones the limit cuts.
  const cutEdges = new Set<string>();
  const unresolved = [...edges.keys()].filter((key) => !live.has(key));
  if (unresolved.length > 0) {
    const height = new Map<string, number>();
    const order = new Map<string, number>();
    const low = new Map<string, number>();
    const component = new Map<string, number>();
    const sccStack: Array<string> = [];
    const onSccStack = new Set<string>();
    let nextOrder = 0;
    let nextComponent = 0;
    // Live threads never reach an unresolved one, so they stay out of this graph.
    const successors = (key: string) => (edges.get(key) ?? []).filter((next) => !live.has(next));
    const enter = (key: string, frames: Array<TarjanFrame>) => {
      count();
      order.set(key, nextOrder);
      low.set(key, nextOrder);
      nextOrder++;
      sccStack.push(key);
      onSccStack.add(key);
      frames.push({ key, next: successors(key), at: 0 });
    };
    for (const root of unresolved) {
      if (order.has(root)) continue;
      const frames: Array<TarjanFrame> = [];
      enter(root, frames);
      while (frames.length > 0) {
        const frame = frames[frames.length - 1]!;
        if (frame.at < frame.next.length) {
          const next = frame.next[frame.at++]!;
          count();
          if (!order.has(next)) enter(next, frames);
          else if (onSccStack.has(next)) {
            low.set(frame.key, Math.min(low.get(frame.key)!, order.get(next)!));
          }
          continue;
        }
        frames.pop();
        const parent = frames[frames.length - 1];
        if (parent !== undefined) {
          low.set(parent.key, Math.min(low.get(parent.key)!, low.get(frame.key)!));
        }
        if (low.get(frame.key) !== order.get(frame.key)) continue;
        // frame.key roots a component; every component below it already has its height.
        const members: Array<string> = [];
        const id = nextComponent++;
        let member: string;
        do {
          member = sccStack.pop()!;
          onSccStack.delete(member);
          component.set(member, id);
          members.push(member);
        } while (member !== frame.key);
        let below = 0;
        for (const key of members) {
          for (const next of successors(key)) {
            count();
            if (component.get(next) !== id) below = Math.max(below, height.get(next)!);
          }
        }
        for (const key of members) height.set(key, below + 1);
      }
    }
    for (const key of unresolved) {
      for (const next of successors(key)) {
        count();
        if (height.get(next)! < THREAD_WAIT_DEPTH_LIMIT) continue;
        cutEdges.add(edgeKey(key, next));
        if (!live.has(key)) {
          live.add(key);
          queue.push(key);
        }
      }
    }
    spread();
  }

  const result = new Map<string, ResolvedThreadWait>();
  for (const [key, targets] of classified) {
    const shell = shells.get(key)!;
    result.set(key, {
      waiting: shell.waitPhase === "waiting" && live.has(key),
      targets: targets.map((target): ResolvedWaitTarget => {
        if (target.kind === "final") {
          return {
            ...target.base,
            state: target.state,
            ...(target.suffix === undefined ? {} : { suffix: target.suffix }),
          };
        }
        const isLive = live.has(target.key) || cutEdges.has(edgeKey(key, target.key));
        return { ...target.base, state: isLive ? "live" : "ended" };
      }),
    });
  }
  return result;
}
