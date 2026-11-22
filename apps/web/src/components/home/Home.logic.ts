import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { resolveThreadWorkingStartedAt } from "@t3tools/client-runtime/state/models";
import { threadWaitKey, type ResolvedThreadWait } from "@t3tools/client-runtime/state/thread-wait";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { resolveSidebarThreadStatus, type SidebarThreadWait } from "../Sidebar.logic";
import {
  countHomeDashboardRows,
  deriveHomeDashboardRows,
  type HomeDashboardRow,
} from "@t3tools/client-runtime/state/homeDashboard";

export type HomeSection = "needs" | "waiting" | "done" | "running";
export type HomeRow = HomeDashboardRow & {
  /** The resolved cross-thread wait; absent on servers without wait fields. */
  readonly wait?: ResolvedThreadWait;
};
export interface HomeCounts {
  readonly needs: number;
  readonly waiting: number;
  readonly done: number;
  readonly running: number;
}

export function formatHomeCounts(
  counts: HomeCounts,
  labels: { readonly done?: string } = {},
): string {
  return homeCountSegments(counts, labels)
    .map((segment) => segment.text)
    .join(" · ");
}

export function homeCountSegments(
  counts: HomeCounts,
  labels: { readonly done?: string } = {},
): ReadonlyArray<{ readonly section: HomeSection; readonly text: string }> {
  return [
    ...(counts.needs > 0 ? [{ section: "needs" as const, text: `${counts.needs} need you` }] : []),
    ...(counts.waiting > 0
      ? [{ section: "waiting" as const, text: `${counts.waiting} waiting` }]
      : []),
    ...(counts.done > 0
      ? [{ section: "done" as const, text: `${counts.done} ${labels.done ?? "done"}` }]
      : []),
    ...(counts.running > 0
      ? [{ section: "running" as const, text: `${counts.running} running` }]
      : []),
  ];
}

const HOUR = 60;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/** Rounded relative duration shared by every Home time label: "5 min", "3 h", "2 days". */
export function formatHomeDuration(minutes: number): string {
  const total = Number.isFinite(minutes) ? Math.max(0, minutes) : 0;
  const unit = (size: number, max: number, one: string, many: string) => {
    const value = Math.min(max, Math.max(1, Math.round(total / size)));
    return `${value} ${value === 1 ? one : many}`;
  };
  if (total < HOUR) return `${Math.min(59, Math.round(total))} min`;
  if (total < DAY) return unit(HOUR, 23, "h", "h");
  if (total < WEEK) return unit(DAY, 6, "day", "days");
  if (total < 5 * WEEK) return unit(WEEK, 4, "week", "weeks");
  if (total < 12 * MONTH) return unit(MONTH, 11, "month", "months");
  return unit(YEAR, Number.MAX_SAFE_INTEGER, "year", "years");
}

function elapsedLabel(from: string | null | undefined, now: number): string | null {
  if (!from) return null;
  const timestamp = Date.parse(from);
  if (!Number.isFinite(timestamp)) return null;
  return formatHomeDuration(Math.max(0, (now - timestamp) / 60_000));
}

function isSameLocalDay(a: string, b: number, timeZone?: string): boolean {
  const day = (ms: number) =>
    new Intl.DateTimeFormat("en-CA", timeZone ? { timeZone } : undefined).format(new Date(ms));
  return day(Date.parse(a)) === day(b);
}

/** When a resolved Waiting started: the run's start while it still runs, else when it ended. */
function homeWaitingSince(thread: EnvironmentThreadShell): string {
  const runActive = thread.latestRun !== null && thread.latestRun.completedAt === null;
  return runActive
    ? (resolveThreadWorkingStartedAt({ latestRun: thread.latestRun, runtime: thread.runtime }) ??
        thread.latestRun?.startedAt ??
        thread.updatedAt)
    : (thread.latestRun?.completedAt ?? thread.updatedAt);
}

export function homeDurationMinutes(
  thread: EnvironmentThreadShell,
  now: string,
  wait?: SidebarThreadWait,
): number {
  const status = resolveSidebarThreadStatus(thread, wait);
  if (wait?.waiting === true || thread.homeFirstNextStep?.startsWith("T3: WAIT on ")) {
    const start = Date.parse(
      wait?.waiting === true
        ? homeWaitingSince(thread)
        : (thread.latestRun?.completedAt ?? thread.updatedAt),
    );
    const end = Date.parse(now);
    return Number.isFinite(start) && Number.isFinite(end)
      ? Math.max(0, Math.floor((end - start) / 60_000))
      : 0;
  }
  const timestamp =
    status === "approval" || status === "input" || status === "request"
      ? (thread.pendingUserInputAt ?? thread.latestRun?.completedAt ?? thread.updatedAt)
      : status === "working" ||
          status === "preparing" ||
          status === "waiting" ||
          status === "limited"
        ? (resolveThreadWorkingStartedAt({
            latestRun: thread.latestRun,
            runtime: thread.runtime,
          }) ??
          thread.latestRun?.startedAt ??
          thread.latestRun?.requestedAt ??
          thread.updatedAt)
        : (thread.latestRun?.completedAt ?? thread.updatedAt);
  const start = Date.parse(timestamp);
  const end = Date.parse(now);
  return Number.isFinite(start) && Number.isFinite(end)
    ? Math.max(0, Math.floor((end - start) / 60_000))
    : 0;
}

export function homeThreadWasStopped(thread: EnvironmentThreadShell): boolean {
  const status = thread.latestRun?.status;
  return status === "cancelled" || status === "interrupted" || status === "rolled_back";
}

function clockLabel(value: string | null | undefined, timeZone?: string): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(value));
}

export function formatHomeTimeLabel(
  thread: EnvironmentThreadShell,
  now: string,
  timeZone?: string,
  wait?: SidebarThreadWait,
): string {
  const nowMs = Date.parse(now);
  const status = resolveSidebarThreadStatus(thread, wait);
  if (wait?.waiting === true && status === "waiting") {
    return `waiting ${elapsedLabel(homeWaitingSince(thread), nowMs) ?? formatHomeDuration(0)}`;
  }
  if (wait === undefined && thread.homeFirstNextStep?.startsWith("T3: WAIT on ")) {
    const since = thread.latestRun?.completedAt ?? thread.updatedAt;
    return `waiting ${elapsedLabel(since, nowMs) ?? formatHomeDuration(0)}`;
  }
  if (status === "approval" || status === "input" || status === "request") {
    const since = thread.pendingUserInputAt ?? thread.latestRun?.completedAt ?? thread.updatedAt;
    const age = elapsedLabel(since, nowMs) ?? formatHomeDuration(0);
    const at = isSameLocalDay(since, nowMs, timeZone) ? clockLabel(since, timeZone) : null;
    return `waiting on you for ${age}${at ? ` since ${at}` : ""}`;
  }
  if (homeThreadWasStopped(thread)) {
    const at = thread.latestRun?.completedAt ?? thread.updatedAt;
    return `stopped ${elapsedLabel(at, nowMs) ?? formatHomeDuration(0)} ago`;
  }
  if (
    status === "working" ||
    status === "preparing" ||
    status === "waiting" ||
    status === "limited"
  ) {
    const startedAt = resolveThreadWorkingStartedAt({
      latestRun: thread.latestRun,
      runtime: thread.runtime,
    });
    const fallback =
      thread.latestRun?.startedAt ?? thread.latestRun?.requestedAt ?? thread.updatedAt;
    return `running ${elapsedLabel(startedAt ?? fallback, nowMs) ?? formatHomeDuration(0)}`;
  }
  if (status === "failed") {
    const at = thread.latestRun?.completedAt ?? thread.updatedAt;
    return `failed ${elapsedLabel(at, nowMs) ?? formatHomeDuration(0)} ago`;
  }
  const completedAt = thread.latestRun?.completedAt ?? thread.updatedAt;
  return `done ${elapsedLabel(completedAt, nowMs) ?? formatHomeDuration(0)} ago`;
}

export function homeComposerProjectRef(
  projects: ReadonlyArray<EnvironmentProject>,
  selectedProjectKey: string | null,
): ScopedProjectRef | null {
  const project = projects.find(
    (candidate) =>
      candidate.archivedAt == null &&
      scopedProjectKey(scopeProjectRef(candidate.environmentId, candidate.id)) ===
        selectedProjectKey,
  );
  return project ? scopeProjectRef(project.environmentId, project.id) : null;
}

export function deriveHomeRows(input: {
  threads: ReadonlyArray<EnvironmentThreadShell>;
  projects: ReadonlyArray<EnvironmentProject>;
  now: string;
  lastVisitedAt: string | null;
  /** Tasks delegated from a listed parent; the sidebar shows those under the parent. */
  delegatedUnderParent?: ReadonlySet<string>;
  /** Resolved waits by `threadWaitKey`; they decide the waiting section on new servers. */
  waits?: ReadonlyMap<string, ResolvedThreadWait>;
}): ReadonlyArray<HomeRow> {
  const rows = deriveHomeDashboardRows(input);
  const waits = input.waits;
  if (waits === undefined || waits.size === 0) return rows;
  return rows.map((row) => {
    const wait = waits.get(threadWaitKey(row.thread.environmentId, row.thread.id));
    return wait === undefined ? row : { ...row, wait, section: homeWaitSection(row, wait) };
  });
}

/**
 * A resolved wait owns the waiting section: in while a target runs, out once all ended. A thread
 * parked at idle without a live target is done, so its section agrees with its "done" label.
 */
function homeWaitSection(row: HomeDashboardRow, wait: ResolvedThreadWait): HomeSection {
  if (row.section === "needs") return "needs";
  if (wait.waiting) return "waiting";
  const runtime = row.thread.runtime?.status;
  if (row.section === "running" && runtime === "idle") return "done";
  if (row.section !== "waiting") return row.section;
  return runtime === "preparing" ||
    runtime === "queued" ||
    runtime === "starting" ||
    runtime === "running" ||
    runtime === "waiting"
    ? "running"
    : "done";
}

export function countHomeRows(rows: ReadonlyArray<HomeRow>): HomeCounts {
  return countHomeDashboardRows(rows);
}

export function homeThreadRef(thread: EnvironmentThreadShell) {
  return scopeThreadRef(thread.environmentId, thread.id);
}
