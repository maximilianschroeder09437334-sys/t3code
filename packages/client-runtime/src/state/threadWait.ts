import {
  displayParentThreadId,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2WaitPhase,
  type OrchestrationV2WaitTarget,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import {
  isPullRequestWatchTask,
  pullRequestWatchTaskId,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { waitEndsByLifecycle } from "@t3tools/shared/orchestrationV2WaitState";

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
  | "lineage"
  | "pullRequests"
> &
  Partial<
    Pick<
      EnvironmentThreadShell,
      | "latestRunSenderThreadId"
      | "pendingBackgroundTasks"
      | "ownerThreadId"
      | "formerOwnerThreadIds"
    >
  > & {
    /** Read only for whether an activity run is open; a parked runtime hides a waiting run. */
    readonly source?: Partial<Pick<OrchestrationV2ThreadShell, "activityRunStatus">>;
  };

export type ResolvedWaitTargetState = "live" | "unknown" | "ended";

/** What a target is, for "Waiting on <kind> <title>". */
export type WaitTargetKind =
  | "subagent"
  | "thread"
  | "pull_request"
  | "command"
  | "monitor"
  | "background_task";

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
  readonly kind: WaitTargetKind;
  readonly state: ResolvedWaitTargetState;
  readonly suffix?: "needs you" | "starting" | "not connected";
  /** A watched pull request's link, for Open to show it in the pull request view. */
  readonly pullRequestUrl?: string;
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

/** An activity run is open: the server's own report when it sends one, else the runtime. */
function hasActivityRun(shell: ThreadWaitShell): boolean {
  return (shell.source?.activityRunStatus ?? null) !== null || threadRuntimeIsActive(shell.runtime);
}

/** The server's lifecycle precedence (see `waitEndsByLifecycle`), from the shell's own fields. */
function lifecycleEnded(shell: ThreadWaitShell): boolean {
  return waitEndsByLifecycle({
    archivedOrDeleted: shell.archivedAt !== null || shell.deletedAt !== null,
    settled: shell.settledOverride === "settled",
    latestRunStatus: shell.latestRun?.status ?? "idle",
    hasActivityRun: hasActivityRun(shell),
  });
}

/**
 * The thread a subagent child keeps waiting: the thread whose agent started the child's open run,
 * else its display parent (a migrated child's owner). A sender other than the parent drives only
 * that run, so once the run ends nobody waits on the child: the parent does not take back a run it
 * did not start. The lineage parent and former owners of a migrated child send as its owner.
 */
function waitDriverOf(shell: ThreadWaitShell): ThreadId | null {
  if (shell.lineage.relationshipToParent !== "subagent") return null;
  // A closed child holds nothing: its own wait ends before anything it waits on.
  if (shell.archivedAt !== null || shell.deletedAt !== null) return null;
  if (shell.settledOverride === "settled") return null;
  const parent = displayParentThreadId(shell);
  const rawSender = shell.latestRunSenderThreadId ?? null;
  const sender =
    rawSender !== null &&
    (rawSender === shell.lineage.parentThreadId ||
      shell.formerOwnerThreadIds?.includes(rawSender) === true)
      ? parent
      : rawSender;
  if (sender !== null && sender !== shell.id && sender !== parent) {
    return hasActivityRun(shell) ? sender : null;
  }
  return parent;
}

function fallbackTitle(target: OrchestrationV2WaitTarget): string {
  if (target.source === "delegate_wait") return "starting delegate";
  if (target.source === "subagent" || target.source === "awaited_child") return "a subagent";
  return "a thread";
}

/**
 * Thread-backed subagent targets are subagents and other thread targets threads. Work without a
 * thread takes its kind from the waiter's roster entry with the same task id.
 */
function waitTargetKind(
  target: OrchestrationV2WaitTarget,
  rosterKindOf: (taskId: string) => WaitTargetKind | undefined,
): WaitTargetKind {
  const fromSubagent = target.source === "subagent" || target.source === "awaited_child";
  if (target.threadId !== null) return fromSubagent ? "subagent" : "thread";
  if (target.taskId !== undefined && isPullRequestWatchTask({ taskId: target.taskId })) {
    return "pull_request";
  }
  if (!fromSubagent) return "thread";
  const rostered = target.taskId === undefined ? undefined : rosterKindOf(target.taskId);
  return rostered ?? (target.source === "subagent" ? "subagent" : "background_task");
}

type TargetBase = Omit<ResolvedWaitTarget, "state" | "suffix">;

/** Per-waiter maps, each built on first use. */
interface WaiterLookups {
  readonly pullRequestUrlOf: (taskId: string) => string | undefined;
  readonly rosterKindOf: (taskId: string) => WaitTargetKind | undefined;
}

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
 * Joins waiting threads' targets with the targets' own phases, order independent and without
 * recursion. A subagent child is an implicit target of its driver (`waitDriverOf`). Only shells
 * with `waitPhase` (new servers) get an entry.
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

  // Pre-pass, one loop over shells: driver -> the subagent children it implicitly waits on.
  const implicitChildren = new Map<string, Array<string>>();
  for (const [key, shell] of shells) {
    count();
    const driver = waitDriverOf(shell);
    if (driver === null) continue;
    const driverKey = threadWaitKey(shell.environmentId, driver);
    if (driverKey === key || !shells.has(driverKey)) continue;
    const children = implicitChildren.get(driverKey);
    if (children === undefined) implicitChildren.set(driverKey, [key]);
    else children.push(key);
  }
  // Effective phase: an ended thread its lifecycle does not end waits on its children that may
  // still hold it (not ended by their own phase, or holding children of their own).
  const implicitTargets = new Map<string, ReadonlyArray<string>>();
  const phases = new Map<string, OrchestrationV2WaitPhase>();
  for (const [key, shell] of shells) {
    if (shell.waitPhase === undefined) continue;
    let phase = shell.waitPhase;
    const children = phase === "needs" ? undefined : implicitChildren.get(key);
    if (children !== undefined) {
      const holding = children.filter((child) => {
        count();
        return shells.get(child)!.waitPhase !== "ended" || implicitChildren.has(child);
      });
      if (holding.length > 0 && phase === "ended" && !lifecycleEnded(shell)) phase = "waiting";
      if (holding.length > 0 && phase !== "ended") implicitTargets.set(key, holding);
    }
    phases.set(key, phase);
  }
  const phaseOf = (key: string, shell: ThreadWaitShell) => phases.get(key) ?? shell.waitPhase;

  const classify = (
    waiter: ThreadWaitShell,
    target: OrchestrationV2WaitTarget,
    lookups: WaiterLookups,
  ): ClassifiedTarget => {
    count();
    const environmentId = target.environmentId ?? waiter.environmentId;
    const ids = {
      environmentId,
      threadId: target.threadId,
      waiterThreadId: waiter.id,
      source: target.source,
      kind: waitTargetKind(target, lookups.rosterKindOf),
      ...(target.itemId === undefined ? {} : { itemId: target.itemId }),
      ...(target.taskId === undefined ? {} : { taskId: target.taskId }),
    };
    // The waiter's own projection emits these only while they run; they clear at the source.
    if (target.threadId === null) {
      const pullRequestUrl =
        target.taskId !== undefined && isPullRequestWatchTask({ taskId: target.taskId })
          ? lookups.pullRequestUrlOf(target.taskId)
          : undefined;
      return {
        kind: "final",
        base: {
          ...ids,
          title: target.title ?? fallbackTitle(target),
          ...(pullRequestUrl === undefined ? {} : { pullRequestUrl }),
        },
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
    switch (phaseOf(key, shell)) {
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

  /** The explicit targets, then implicit children not already listed, each classified once. */
  const classifyAll = (key: string, shell: ThreadWaitShell): Array<ClassifiedTarget> => {
    let pullRequestUrls: Map<string, string> | undefined;
    const pullRequestUrlOf = (taskId: string) => {
      if (pullRequestUrls === undefined) {
        pullRequestUrls = new Map();
        for (const link of shell.pullRequests) {
          count();
          pullRequestUrls.set(pullRequestWatchTaskId(link), link.url);
        }
      }
      return pullRequestUrls.get(taskId);
    };
    let rosterKinds: Map<string, WaitTargetKind> | undefined;
    const rosterKindOf = (taskId: string) => {
      if (rosterKinds === undefined) {
        rosterKinds = new Map();
        for (const task of shell.pendingBackgroundTasks ?? []) {
          count();
          rosterKinds.set(task.taskId, task.kind);
        }
      }
      return rosterKinds.get(taskId);
    };
    const lookups: WaiterLookups = { pullRequestUrlOf, rosterKindOf };
    const explicit = shell.waitingOn ?? [];
    const targets = explicit.map((target) => classify(shell, target, lookups));
    const implicit = implicitTargets.get(key);
    if (implicit === undefined) return targets;
    const listed = new Set<string>();
    for (const target of explicit) {
      count();
      if (target.threadId === null) continue;
      listed.add(threadWaitKey(target.environmentId ?? shell.environmentId, target.threadId));
    }
    for (const childKey of implicit) {
      if (listed.has(childKey)) continue;
      listed.add(childKey);
      targets.push(
        classify(
          shell,
          {
            source: "awaited_child",
            environmentId: null,
            threadId: shells.get(childKey)!.id,
            title: null,
          },
          lookups,
        ),
      );
    }
    return targets;
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
    const targets = classifyAll(key, shell);
    classified.set(key, targets);
    if (phaseOf(key, shell) !== "waiting") continue;
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
      waiting: phaseOf(key, shell) === "waiting" && live.has(key),
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
