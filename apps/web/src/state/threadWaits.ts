import { useAtomValue } from "@effect/atom-react";
import {
  resolveThreadWaits,
  threadWaitKey,
  type ResolvedThreadWait,
  type ResolvedWaitTarget,
} from "@t3tools/client-runtime/state/thread-wait";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { liveShellEnvironmentIdsAtom } from "./shell";
import { environmentThreadShells } from "./threads";

/** Every thread's resolved wait, built once per shell or readiness change across all environments. */
const threadWaitsAtom = Atom.make((get) => {
  const live = get(liveShellEnvironmentIdsAtom);
  return resolveThreadWaits({
    threads: get(environmentThreadShells.threadShellsAtom),
    environmentReady: (environmentId) => live.has(environmentId),
  });
}).pipe(Atom.withLabel("web-thread-waits"));

function sameTarget(a: ResolvedWaitTarget, b: ResolvedWaitTarget): boolean {
  return (
    a.title === b.title &&
    a.environmentId === b.environmentId &&
    a.threadId === b.threadId &&
    a.waiterThreadId === b.waiterThreadId &&
    a.itemId === b.itemId &&
    a.taskId === b.taskId &&
    a.source === b.source &&
    a.kind === b.kind &&
    a.state === b.state &&
    a.suffix === b.suffix &&
    a.pullRequestUrl === b.pullRequestUrl
  );
}

function sameThreadWait(
  a: ResolvedThreadWait | undefined,
  b: ResolvedThreadWait | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return (
    a.waiting === b.waiting &&
    a.targets.length === b.targets.length &&
    a.targets.every((target, index) => sameTarget(target, b.targets[index]!))
  );
}

// Each recompute builds new objects; a row re-renders only when its own wait changes.
const threadWaitAtom = Atom.family((key: string) => {
  let previous: ResolvedThreadWait | undefined;
  return Atom.make((get) => {
    const next = get(threadWaitsAtom).get(key);
    if (sameThreadWait(previous, next)) return previous;
    previous = next;
    return next;
  }).pipe(Atom.withLabel(`web-thread-wait:${key}`));
});

/** The thread's resolved wait; undefined on servers that send no wait fields. */
export function useThreadWait(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ResolvedThreadWait | undefined {
  return useAtomValue(threadWaitAtom(threadWaitKey(environmentId, threadId)));
}

export function useThreadWaits(): ReadonlyMap<string, ResolvedThreadWait> {
  return useAtomValue(threadWaitsAtom);
}
