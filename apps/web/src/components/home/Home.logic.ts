import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { projectKey } from "@t3tools/client-runtime/state/entities";
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
