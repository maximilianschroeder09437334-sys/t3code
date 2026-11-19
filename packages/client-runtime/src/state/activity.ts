import {
  WS_METHODS,
  type ActivityEvent,
  type EnvironmentId,
  type ThreadContextUsage,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import type { EnvironmentThreadShell } from "./models.ts";
import {
  deriveInFlight,
  deriveNeedsYou,
  deriveOverviewFeed,
  overviewThreadKey,
  selectWorkingThreads,
  type OverviewEnvironmentActivity,
  type OverviewEvent,
  type OverviewFeed,
  type OverviewInFlightRow,
  type OverviewNeedsYouRow,
} from "./overview.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

const NO_EVENTS: ReadonlyArray<ActivityEvent> = Object.freeze([]);
const NO_USAGE: ReadonlyMap<ThreadId, ThreadContextUsage> = new Map();
// The feed is a glance, not an archive: older pushed events drop off while the page stays open.
const LIVE_EVENT_LIMIT = 200;
// Matches the server's cap on one context subscription.
const CONTEXT_THREAD_LIMIT = 50;
// Enough of the ledger's tail to know each active thread's latest word.
const RECENT_EVENTS_INPUT = { limit: 100 } as const;

export interface OverviewLedgerStatus {
  /** Some connected environment has not answered yet. */
  readonly loading: boolean;
  /** Connected environments whose ledger could not be read, such as servers without one. */
  readonly unavailable: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
}

export interface OverviewSeenTarget {
  readonly environmentId: EnvironmentId;
  readonly seenSequence: number;
}

export interface OverviewActivity {
  readonly feed: OverviewFeed;
  /** The ledger's recent tail plus the feed, seen or not: what each thread last reported. */
  readonly latestEvents: ReadonlyArray<OverviewEvent>;
  readonly status: OverviewLedgerStatus;
  /** What "Mark seen" confirms: the newest event shown per environment, never one that arrives later. */
  readonly seenTargets: ReadonlyArray<OverviewSeenTarget>;
}

export function createActivityAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  deps: {
    readonly presentationsAtom: Atom.Atom<
      ReadonlyMap<
        EnvironmentId,
        {
          readonly connection: { readonly phase: string };
          readonly entry: { readonly target: { readonly label: string } };
        }
      >
    >;
    readonly threadShellsAtom: Atom.Atom<ReadonlyArray<EnvironmentThreadShell>>;
  },
) {
  const checkIn = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:activity:check-in",
    tag: WS_METHODS.activityCheckInGet,
    // Another device may have checked in, so reopening the Overview asks again.
    staleTimeMs: 0,
  });
  const recent = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:activity:recent",
    tag: WS_METHODS.activityList,
    staleTimeMs: 0,
  });
  const live = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:activity:live",
    tag: WS_METHODS.activitySubscribe,
    idleTtlMs: 0,
    transform: (events) =>
      events.pipe(
        Stream.scan(
          () => NO_EVENTS,
          (all, event) => [...all, event].slice(-LIVE_EVENT_LIMIT),
        ),
      ),
  });
  const threadContext = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:activity:thread-context",
    tag: WS_METHODS.activitySubscribeThreadContext,
    idleTtlMs: 0,
    transform: (reports) =>
      reports.pipe(
        Stream.scan(
          () => NO_USAGE,
          (all, update) => {
            const next = new Map(all);
            if (update.usage === null) next.delete(update.threadId);
            else next.set(update.threadId, update.usage);
            return next;
          },
        ),
      ),
  });
  const markSeen = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:activity:mark-seen",
    tag: WS_METHODS.activityCheckInMarkSeen,
    onSuccess: ({ environmentId }, registry) =>
      Effect.sync(() => registry.refresh(checkIn({ environmentId, input: {} }))),
  });

  const connectedEnvironmentsAtom = Atom.make((get) =>
    [...get(deps.presentationsAtom)].flatMap(([environmentId, presentation]) =>
      presentation.connection.phase === "connected"
        ? [{ environmentId, label: presentation.entry.target.label }]
        : [],
    ),
  ).pipe(Atom.withLabel("overview:connected-environments"));

  const activityAtom = Atom.make((get): OverviewActivity => {
    const environments: OverviewEnvironmentActivity[] = [];
    const latestEvents: OverviewEvent[] = [];
    const unavailable: Array<OverviewLedgerStatus["unavailable"][number]> = [
      ...get(deps.presentationsAtom),
    ].flatMap(([environmentId, presentation]) =>
      presentation.connection.phase === "connected"
        ? []
        : [{ environmentId, label: presentation.entry.target.label }],
    );
    let loading = false;
    for (const environment of get(connectedEnvironmentsAtom)) {
      const { environmentId } = environment;
      const result = get(checkIn({ environmentId, input: {} }));
      if (!AsyncResult.isSuccess(result)) {
        if (AsyncResult.isFailure(result)) unavailable.push(environment);
        else loading = true;
        continue;
      }
      const answer = result.value;
      const tail = get(recent({ environmentId, input: RECENT_EVENTS_INPUT }));
      if (AsyncResult.isSuccess(tail)) {
        for (const event of tail.value.events) latestEvents.push({ ...event, environmentId });
      }
      const afterSequence = Math.max(
        answer.checkIn?.seenSequence ?? 0,
        answer.events.at(-1)?.sequence ?? 0,
      );
      const liveResult = get(live({ environmentId, input: { afterSequence } }));
      if (AsyncResult.isFailure(tail) || AsyncResult.isFailure(liveResult))
        unavailable.push(environment);
      environments.push({
        environmentId,
        checkIn: answer.checkIn,
        unseen: answer.events,
        truncated: answer.truncated,
        live: AsyncResult.getOrElse(liveResult, () => NO_EVENTS),
      });
    }
    const feed = deriveOverviewFeed(environments);
    const newest = new Map<EnvironmentId, number>();
    for (const event of feed.events) {
      newest.set(
        event.environmentId,
        Math.max(newest.get(event.environmentId) ?? 0, event.sequence),
      );
    }
    latestEvents.push(...feed.events);
    return {
      feed,
      latestEvents,
      status: { loading, unavailable },
      seenTargets: [...newest].map(([environmentId, seenSequence]) => ({
        environmentId,
        seenSequence,
      })),
    };
  }).pipe(Atom.withLabel("overview:activity"));

  const needsYouAtom = Atom.make((get): ReadonlyArray<OverviewNeedsYouRow> =>
    deriveNeedsYou({
      threads: get(deps.threadShellsAtom),
      events: get(activityAtom).latestEvents,
    }),
  ).pipe(Atom.withLabel("overview:needs-you"));

  // The id list keys the context subscription, so it must only change when the set does.
  const workingThreadIdsAtom = Atom.make((get) => {
    const byEnvironment = new Map<EnvironmentId, ThreadId[]>();
    for (const thread of selectWorkingThreads(get(deps.threadShellsAtom))) {
      const ids = byEnvironment.get(thread.environmentId) ?? [];
      ids.push(thread.id);
      byEnvironment.set(thread.environmentId, ids);
    }
    return JSON.stringify(
      [...byEnvironment]
        .map(([environmentId, ids]) => [environmentId, ids.sort().slice(0, CONTEXT_THREAD_LIMIT)])
        .sort(([left], [right]) => String(left).localeCompare(String(right))),
    );
  }).pipe(Atom.withLabel("overview:working-thread-ids"));

  const inFlightAtom = Atom.make((get): ReadonlyArray<OverviewInFlightRow> => {
    const contextUsage = new Map<string, ThreadContextUsage>();
    const connected = new Set(
      get(connectedEnvironmentsAtom).map((environment) => environment.environmentId),
    );
    const working = JSON.parse(get(workingThreadIdsAtom)) as ReadonlyArray<
      readonly [EnvironmentId, ReadonlyArray<ThreadId>]
    >;
    for (const [environmentId, threadIds] of working) {
      if (!connected.has(environmentId)) continue;
      const reports = AsyncResult.getOrElse(
        get(threadContext({ environmentId, input: { threadIds } })),
        () => NO_USAGE,
      );
      for (const usage of reports.values()) {
        contextUsage.set(overviewThreadKey(environmentId, usage.threadId), usage);
      }
    }
    return deriveInFlight({ threads: get(deps.threadShellsAtom), contextUsage });
  }).pipe(Atom.withLabel("overview:in-flight"));

  return { activityAtom, needsYouAtom, inFlightAtom, markSeen };
}
