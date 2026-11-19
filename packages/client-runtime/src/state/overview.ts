import {
  isListedThreadLineage,
  type ActivityCheckIn,
  type ActivityEvent,
  type EnvironmentId,
  type ThreadContextUsage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { EnvironmentThreadShell } from "./models.ts";
import { isThreadWorking } from "./threadInbox.ts";

/** A ledger event tagged with the environment whose ledger holds it. */
export interface OverviewEvent extends ActivityEvent {
  readonly environmentId: EnvironmentId;
}

export type OverviewNeedsYouReason = "approval" | "question" | "needs_you" | "blocked";

export interface OverviewNeedsYouRow {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: EnvironmentThreadShell["id"];
  readonly projectId: EnvironmentThreadShell["projectId"];
  readonly title: string;
  readonly reason: OverviewNeedsYouReason;
  /** The agent's own words from the ledger; null for a pending request, which the thread shows. */
  readonly summary: string | null;
  readonly next: string | null;
  /** When the thread started waiting, or null when the server did not say. */
  readonly since: string | null;
}

export interface OverviewContextGauge {
  readonly usedTokens: number;
  /** Null when the provider reported no window, so no percentage can be shown. */
  readonly maxTokens: number | null;
  readonly usedPercent: number | null;
}

export interface OverviewInFlightRow {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: EnvironmentThreadShell["id"];
  readonly projectId: EnvironmentThreadShell["projectId"];
  readonly title: string;
  readonly providerInstanceId: EnvironmentThreadShell["providerInstanceId"];
  readonly model: string;
  /** When the current work started, or null when unknown. */
  readonly startedAt: string | null;
  /** Null until the thread's provider reports usage. */
  readonly context: OverviewContextGauge | null;
}

export interface OverviewFeed {
  /** Newest first. */
  readonly events: ReadonlyArray<OverviewEvent>;
  /** Some environment held more unseen events than it sent. */
  readonly truncated: boolean;
  /** The oldest check-in across environments, or null when any environment has none. */
  readonly lastSeenAt: string | null;
}

/** One environment's ledger as the Overview reads it. */
export interface OverviewEnvironmentActivity {
  readonly environmentId: EnvironmentId;
  readonly checkIn: ActivityCheckIn | null;
  /** Events after the check-in, as the server answered. */
  readonly unseen: ReadonlyArray<ActivityEvent>;
  readonly truncated: boolean;
  /** Events pushed since that answer. */
  readonly live: ReadonlyArray<ActivityEvent>;
}

export const overviewThreadKey = (environmentId: EnvironmentId, threadId: string) =>
  `${environmentId}\u0000${threadId}`;

const timestamp = (value: string | null | undefined) => {
  const parsed = value == null ? Number.NaN : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function isOpenThread(thread: EnvironmentThreadShell): boolean {
  return (
    thread.archivedAt === null &&
    thread.deletedAt === null &&
    thread.settledOverride !== "settled" &&
    (thread.settledOverride === "active" || thread.settledAt === null)
  );
}

/** Unseen and live events of every environment, deduplicated, newest first. */
export function deriveOverviewFeed(
  environments: ReadonlyArray<OverviewEnvironmentActivity>,
): OverviewFeed {
  const events: OverviewEvent[] = [];
  let lastSeenAt: string | null = null;
  let everyEnvironmentCheckedIn = environments.length > 0;
  for (const environment of environments) {
    const seenSequence = environment.checkIn?.seenSequence ?? 0;
    const seen = new Set<number>();
    for (const event of [...environment.unseen, ...environment.live]) {
      if (event.sequence <= seenSequence || seen.has(event.sequence)) continue;
      seen.add(event.sequence);
      events.push({ ...event, environmentId: environment.environmentId });
    }
    if (environment.checkIn === null) everyEnvironmentCheckedIn = false;
    else if (lastSeenAt === null || environment.checkIn.seenAt < lastSeenAt) {
      lastSeenAt = environment.checkIn.seenAt;
    }
  }
  events.sort(
    (left, right) =>
      (timestamp(right.at) ?? 0) - (timestamp(left.at) ?? 0) ||
      right.sequence - left.sequence ||
      left.environmentId.localeCompare(right.environmentId),
  );
  return {
    events,
    truncated: environments.some((environment) => environment.truncated),
    lastSeenAt: everyEnvironmentCheckedIn ? lastSeenAt : null,
  };
}

/**
 * Threads waiting on the user: an open approval or question, or a thread whose latest ledger
 * word is `needs_you` or `blocked`. A ledger request stays open until the thread reports again,
 * runs again, or is settled, so checking in does not hide work that is still stuck.
 */
export function deriveNeedsYou(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly events: ReadonlyArray<OverviewEvent>;
}): ReadonlyArray<OverviewNeedsYouRow> {
  const rows: OverviewNeedsYouRow[] = [];
  const waiting = new Set<string>();
  const threadsByKey = new Map<string, EnvironmentThreadShell>();
  for (const thread of input.threads) {
    const key = overviewThreadKey(thread.environmentId, thread.id);
    threadsByKey.set(key, thread);
    if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
    const reason: OverviewNeedsYouReason | null =
      thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval"
        ? "approval"
        : thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input"
          ? "question"
          : null;
    if (reason === null) continue;
    waiting.add(key);
    const requestedAt = thread.source.pendingRuntimeRequest?.createdAt;
    rows.push({
      key: `${key}\u0000${reason}`,
      environmentId: thread.environmentId,
      threadId: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      reason,
      summary: null,
      next: null,
      since: requestedAt === undefined ? null : DateTime.formatIso(requestedAt),
    });
  }

  const latestByThread = new Map<string, OverviewEvent>();
  for (const event of input.events) {
    const key = overviewThreadKey(event.environmentId, event.threadId);
    const latest = latestByThread.get(key);
    if (latest === undefined || event.sequence > latest.sequence) latestByThread.set(key, event);
  }
  for (const [key, event] of latestByThread) {
    if ((event.kind !== "needs_you" && event.kind !== "blocked") || waiting.has(key)) continue;
    const thread = threadsByKey.get(key);
    // A thread this client no longer lists was settled or removed, which answers the request.
    if (thread === undefined || !isOpenThread(thread)) continue;
    const reportedAt = timestamp(event.at);
    const ranAgainAt = timestamp(thread.latestRun?.requestedAt);
    if (reportedAt !== null && ranAgainAt !== null && ranAgainAt > reportedAt) continue;
    rows.push({
      key: `${key}\u0000${event.kind}`,
      environmentId: event.environmentId,
      threadId: event.threadId,
      projectId: event.projectId,
      title: thread.title,
      reason: event.kind,
      summary: event.summary,
      next: event.next ?? null,
      since: event.at,
    });
  }
  // Longest wait first; an unknown wait sorts last rather than pretending to be new or old.
  return rows.sort(
    (left, right) =>
      (timestamp(left.since) ?? Number.POSITIVE_INFINITY) -
        (timestamp(right.since) ?? Number.POSITIVE_INFINITY) || left.key.localeCompare(right.key),
  );
}

function contextGauge(usage: ThreadContextUsage | undefined): OverviewContextGauge | null {
  if (usage === undefined) return null;
  const maxTokens = usage.maxTokens !== null && usage.maxTokens > 0 ? usage.maxTokens : null;
  return {
    usedTokens: usage.usedTokens,
    maxTokens,
    usedPercent:
      maxTokens === null ? null : Math.min(100, Math.round((usage.usedTokens / maxTokens) * 100)),
  };
}

/** Threads working right now. Subagents and side chats show inside their parent, so they are left out. */
export function selectWorkingThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<EnvironmentThreadShell> {
  return threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      isListedThreadLineage(thread.lineage) &&
      isThreadWorking(thread),
  );
}

export function deriveInFlight(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  /** Keyed by `overviewThreadKey`. */
  readonly contextUsage: ReadonlyMap<string, ThreadContextUsage>;
}): ReadonlyArray<OverviewInFlightRow> {
  return selectWorkingThreads(input.threads)
    .map((thread): OverviewInFlightRow => {
      const key = overviewThreadKey(thread.environmentId, thread.id);
      return {
        key,
        environmentId: thread.environmentId,
        threadId: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        providerInstanceId: thread.providerInstanceId,
        model: thread.modelSelection.model,
        startedAt:
          thread.runtime?.activityStartedAt ??
          thread.latestRun?.startedAt ??
          thread.latestRun?.requestedAt ??
          null,
        context: contextGauge(input.contextUsage.get(key)),
      };
    })
    .sort(
      (left, right) =>
        (timestamp(left.startedAt) ?? Number.POSITIVE_INFINITY) -
          (timestamp(right.startedAt) ?? Number.POSITIVE_INFINITY) ||
        left.key.localeCompare(right.key),
    );
}

/** `1h 05m`, `12m`, `under 1m`; null when the start is unknown or in the future. */
export function formatOverviewElapsed(startedAt: string | null, nowMs: number): string | null {
  const started = timestamp(startedAt);
  if (started === null || started > nowMs) return null;
  const minutes = Math.floor((nowMs - started) / 60_000);
  if (minutes < 1) return "under 1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** `84k / 200k`, or `84k` alone when the window is unknown. */
export function formatOverviewContext(context: OverviewContextGauge): string {
  const compact = (tokens: number) =>
    tokens >= 1_000_000
      ? `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
      : tokens >= 1_000
        ? `${Math.round(tokens / 1_000)}k`
        : String(tokens);
  return context.maxTokens === null
    ? compact(context.usedTokens)
    : `${compact(context.usedTokens)} / ${compact(context.maxTokens)}`;
}
