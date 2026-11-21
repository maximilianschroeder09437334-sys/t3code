import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { resolveThreadWorkingStartedAt } from "@t3tools/client-runtime/state/models";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { isShownUnderParent } from "@t3tools/client-runtime/state/threads";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";

export type HomeSection = "needs" | "done" | "running";
export interface HomeRow {
  readonly thread: EnvironmentThreadShell;
  readonly section: HomeSection;
  readonly projectName: string;
  readonly projectKey: string;
  readonly predecessors: ReadonlyArray<EnvironmentThreadShell>;
}
export interface HomeCounts {
  readonly needs: number;
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

export function homeDurationMinutes(thread: EnvironmentThreadShell, now: string): number {
  const status = resolveSidebarThreadStatus(thread);
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
): string {
  const nowMs = Date.parse(now);
  const status = resolveSidebarThreadStatus(thread);
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

function sectionFor(thread: EnvironmentThreadShell): HomeSection {
  const status = resolveSidebarThreadStatus(thread);
  if (status === "approval" || status === "input" || status === "request") return "needs";
  return status === "preparing" ||
    status === "working" ||
    status === "waiting" ||
    status === "limited"
    ? "running"
    : "done";
}

function workstream(thread: EnvironmentThreadShell): string {
  const prefix = thread.title.split(": ", 1)[0]?.trim();
  return prefix ? prefix.toLocaleLowerCase() : thread.id;
}

function workstreamKey(thread: EnvironmentThreadShell): string {
  return `${scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId))}\u0001${workstream(thread)}`;
}

function activity(thread: EnvironmentThreadShell): number {
  return Date.parse(thread.latestUserMessageAt ?? thread.updatedAt) || 0;
}

const NO_DELEGATED: ReadonlySet<string> = new Set();

export function deriveHomeRows(input: {
  threads: ReadonlyArray<EnvironmentThreadShell>;
  projects: ReadonlyArray<EnvironmentProject>;
  now: string;
  lastVisitedAt: string | null;
  /** Tasks delegated from a listed parent; the sidebar shows those under the parent. */
  delegatedUnderParent?: ReadonlySet<string>;
}): ReadonlyArray<HomeRow> {
  const projects = new Map(
    input.projects.map((project) => [
      scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
      project,
    ]),
  );
  const usable = input.threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      // Same rule as the sidebar: subagents, side chats and delegated tasks live under their
      // parent. Forks are ordinary top-level threads and stay.
      !isShownUnderParent(
        { environmentId: thread.environmentId, threadId: thread.id },
        thread.lineage,
        input.delegatedUnderParent ?? NO_DELEGATED,
      ) &&
      !effectiveSnoozed(thread, { now: input.now }),
  );
  const active = usable.filter((thread) => thread.settledOverride !== "settled");
  const newestByWorkstream = new Map<string, EnvironmentThreadShell>();
  for (const thread of active) {
    const key = workstreamKey(thread);
    const previous = newestByWorkstream.get(key);
    if (previous === undefined || activity(thread) > activity(previous))
      newestByWorkstream.set(key, thread);
  }
  const rows: HomeRow[] = active.map((thread) => {
    const projectKeyValue = scopedProjectKey(
      scopeProjectRef(thread.environmentId, thread.projectId),
    );
    const project = projects.get(projectKeyValue);
    const predecessors =
      newestByWorkstream.get(workstreamKey(thread))?.id !== thread.id
        ? []
        : usable
            .filter(
              (candidate) =>
                candidate.settledOverride === "settled" &&
                workstreamKey(candidate) === workstreamKey(thread) &&
                activity(candidate) < activity(thread),
            )
            .sort((a, b) => activity(b) - activity(a))
            .slice(0, 10);
    return {
      thread,
      section: sectionFor(thread),
      projectName: project?.title ?? "Unknown project",
      projectKey: projectKeyValue,
      predecessors,
    };
  });
  const sectionOrder: Record<HomeSection, number> = { needs: 0, done: 1, running: 2 };
  const projectOrder = new Map(
    [...input.projects].map((project, index) => [
      scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
      index,
    ]),
  );
  return rows.sort(
    (a, b) =>
      sectionOrder[a.section] - sectionOrder[b.section] ||
      (projectOrder.get(a.projectKey) ?? Infinity) - (projectOrder.get(b.projectKey) ?? Infinity) ||
      activity(b.thread) - activity(a.thread),
  );
}

export function countHomeRows(rows: ReadonlyArray<HomeRow>): HomeCounts {
  const counts = {
    needs: 0,
    done: 0,
    running: 0,
  };
  for (const row of rows) counts[row.section] += 1;
  return counts;
}

export function homeThreadRef(thread: EnvironmentThreadShell) {
  return scopeThreadRef(thread.environmentId, thread.id);
}
