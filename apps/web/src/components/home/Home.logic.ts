import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { projectKey } from "@t3tools/client-runtime/state/entities";
import { resolveThreadWorkingStartedAt } from "@t3tools/client-runtime/state/models";
import type { ScopedProjectRef } from "@t3tools/contracts";
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
  return homeCountSegments(counts, labels).map((segment) => segment.text).join(" · ");
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

function elapsedLabel(from: string | null | undefined, now: number): string | null {
  if (!from) return null;
  const timestamp = Date.parse(from);
  if (!Number.isFinite(timestamp)) return null;
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  return `${minutes}m`;
}

export function homeDurationMinutes(thread: EnvironmentThreadShell, now: string): number {
  const status = resolveSidebarThreadStatus(thread);
  const timestamp =
    status === "approval" || status === "input" || status === "request"
      ? (thread.pendingUserInputAt ?? thread.latestRun?.completedAt ?? thread.updatedAt)
      : status === "working" || status === "preparing" || status === "waiting" || status === "limited"
        ? (resolveThreadWorkingStartedAt({
            latestRun: thread.latestRun,
            runtime: thread.runtime,
          }) ?? thread.latestRun?.startedAt ?? thread.latestRun?.requestedAt ?? thread.updatedAt)
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
    const at = clockLabel(since, timeZone) ?? "--:--";
    const age = elapsedLabel(since, nowMs) ?? "0m";
    return `waiting on you since ${at} (${age})`;
  }
  if (homeThreadWasStopped(thread)) {
    return `stopped ${clockLabel(thread.latestRun?.completedAt ?? thread.updatedAt, timeZone) ?? "--:--"}`;
  }
  if (status === "working" || status === "preparing" || status === "waiting" || status === "limited") {
    const startedAt = resolveThreadWorkingStartedAt({
      latestRun: thread.latestRun,
      runtime: thread.runtime,
    });
    const fallback = thread.latestRun?.startedAt ?? thread.latestRun?.requestedAt ?? thread.updatedAt;
    const timestamp = startedAt ?? fallback;
    const age = elapsedLabel(timestamp, nowMs);
    return `running ${age ?? "0m"}`;
  }
  if (status === "failed") {
    return `failed ${clockLabel(thread.latestRun?.completedAt ?? thread.updatedAt, timeZone) ?? "--:--"}`;
  }
  const completedAt = thread.latestRun?.completedAt ?? thread.updatedAt;
  return `done ${elapsedLabel(completedAt, nowMs) ?? "0m"} ago`;
}

export function homeComposerProjectRef(
  projects: ReadonlyArray<EnvironmentProject>,
  selectedProjectKey: string | null,
): ScopedProjectRef | null {
  const project = projects.find(
    (candidate) =>
      candidate.archivedAt == null &&
      projectKey(scopeProjectRef(candidate.environmentId, candidate.id)) === selectedProjectKey,
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
  return `${projectKey(scopeProjectRef(thread.environmentId, thread.projectId))}\u0001${workstream(thread)}`;
}

function activity(thread: EnvironmentThreadShell): number {
  return Date.parse(thread.latestUserMessageAt ?? thread.updatedAt) || 0;
}

export function deriveHomeRows(input: {
  threads: ReadonlyArray<EnvironmentThreadShell>;
  projects: ReadonlyArray<EnvironmentProject>;
  now: string;
  lastVisitedAt: string | null;
}): ReadonlyArray<HomeRow> {
  const projects = new Map(
    input.projects.map((project) => [
      projectKey(scopeProjectRef(project.environmentId, project.id)),
      project,
    ]),
  );
  const usable = input.threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      thread.lineage.relationshipToParent !== "subagent" &&
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
    const projectKeyValue = projectKey(scopeProjectRef(thread.environmentId, thread.projectId));
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
      projectKey(scopeProjectRef(project.environmentId, project.id)),
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
