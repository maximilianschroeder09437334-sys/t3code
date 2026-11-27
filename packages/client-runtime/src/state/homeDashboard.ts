import { scopedProjectKey, scopeProjectRef } from "../environment/index.ts";
import type { EnvironmentProject, EnvironmentThreadShell } from "./models.ts";
import { isShownUnderParent } from "./threadShell.ts";
import { effectiveSnoozed } from "./threadSettled.ts";
import { parseHomeNextStep } from "@t3tools/shared/homeNextStep";

export type HomeDashboardSection = "needs" | "waiting" | "done" | "running";

export interface HomeDashboardCounts {
  readonly needs: number;
  readonly done: number;
  readonly running: number;
  readonly waiting: number;
}

export interface HomeDashboardRowLike {
  readonly section: HomeDashboardSection;
  readonly projectKey: string;
}

export interface HomeDashboardRow extends HomeDashboardRowLike {
  readonly thread: EnvironmentThreadShell;
  readonly projectName: string;
  readonly predecessors: ReadonlyArray<EnvironmentThreadShell>;
  readonly waitingOn?: {
    readonly title: string;
    readonly environmentId: string;
    readonly threadId: string;
  };
  readonly waitingThread?: EnvironmentThreadShell;
  /** The waited-on thread asks Maxi for something (report ask, approval, input or guest request). */
  readonly waitingOnNeedsYou?: boolean;
  readonly waitingCount?: number;
}

type HomeThreadStatus =
  | "approval"
  | "input"
  | "request"
  | "waiting"
  | "home-waiting"
  | "preparing"
  | "working"
  | "limited"
  | "failed"
  | "ready";

function homeThreadStatus(thread: EnvironmentThreadShell): HomeThreadStatus {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") return "approval";
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") return "input";
  if ((thread.pendingGuestMessageCount ?? 0) > 0) return "request";
  const homeStep = parseHomeNextStep(thread.homeFirstNextStep ?? "");
  if (
    homeStep?.kind === "needs" &&
    !["preparing", "queued", "starting", "running", "waiting"].includes(
      thread.runtime?.status ?? "",
    )
  )
    return "input";
  if (homeStep?.kind === "wait") return "home-waiting";
  if (
    thread.runtime?.status === "idle" &&
    thread.pendingBackgroundTasks.some(
      (task) => task.kind === "subagent" && task.awaited === true && task.childThreadId != null,
    )
  )
    return "home-waiting";
  if (thread.runtime?.status === "running" && thread.blockedOnThreadWait === true) return "waiting";
  if (thread.runtime?.status === "preparing") return "preparing";
  if (
    thread.runtime !== null &&
    ["queued", "starting", "running", "waiting"].includes(thread.runtime.status)
  )
    return "working";
  if (thread.runtime?.status === "idle") return "waiting";
  if (thread.runtime?.status === "failed")
    return thread.runtime.lastErrorClass === "usage_limit" ? "limited" : "failed";
  return "ready";
}

function sectionFor(thread: EnvironmentThreadShell): HomeDashboardSection {
  if (thread.homeDashboardSection !== undefined) return thread.homeDashboardSection;
  const status = homeThreadStatus(thread);
  if (status === "approval" || status === "input" || status === "request") return "needs";
  if (status === "home-waiting") return "waiting";
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

export function deriveHomeDashboardRows(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly now: string;
  readonly delegatedUnderParent?: ReadonlySet<string>;
}): ReadonlyArray<HomeDashboardRow> {
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
  const threadByRef = new Map(
    input.threads.map((candidate) => [
      `${candidate.environmentId}\u0001${candidate.id}`,
      candidate,
    ]),
  );
  const parsedWait = (thread: EnvironmentThreadShell) => {
    const parsed = parseHomeNextStep(thread.homeFirstNextStep ?? "");
    if (parsed?.kind === "wait") return parsed;
    const child = thread.pendingBackgroundTasks.find(
      (task) => task.kind === "subagent" && task.awaited === true && task.childThreadId != null,
    );
    if (!child || child.kind !== "subagent" || child.childThreadId == null) return undefined;
    const childThread = threadByRef.get(`${thread.environmentId}\u0001${child.childThreadId}`);
    return childThread
      ? {
          title: childThread.title,
          environmentId: thread.environmentId,
          threadId: child.childThreadId,
        }
      : undefined;
  };
  const waitingTargets = new Map(
    active.map((thread) => [
      `${thread.environmentId}\u0001${thread.id}`,
      sectionFor(thread) === "waiting" ? parsedWait(thread) : undefined,
    ]),
  );
  const waitingCounts = new Map<string, number>();
  for (const target of waitingTargets.values()) {
    if (!target) continue;
    const key = `${target.environmentId}\u0001${target.threadId}`;
    waitingCounts.set(key, (waitingCounts.get(key) ?? 0) + 1);
  }
  const rows = active.map((thread): HomeDashboardRow => {
    const projectKey = scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
    const project = projects.get(projectKey);
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
    const waitingOn = thread.homeWaitingOn ?? parsedWait(thread);
    const waitingThread = waitingOn
      ? threadByRef.get(`${waitingOn.environmentId}\u0001${waitingOn.threadId}`)
      : undefined;
    return {
      thread,
      section: sectionFor(thread),
      projectName: project?.title ?? "Unknown project",
      projectKey,
      predecessors,
      ...(waitingOn ? { waitingOn } : {}),
      ...(waitingThread
        ? {
            waitingThread,
            waitingOnNeedsYou: sectionFor(waitingThread) === "needs",
          }
        : {}),
      waitingCount:
        thread.homeWaitingCount ??
        waitingCounts.get(`${thread.environmentId}\u0001${thread.id}`) ??
        0,
    };
  });
  const sectionOrder: Record<HomeDashboardSection, number> = {
    needs: 0,
    waiting: 1,
    done: 2,
    running: 3,
  };
  const projectOrder = new Map(
    input.projects.map((project, index) => [
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

export function countHomeDashboardRows(
  rows: ReadonlyArray<HomeDashboardRowLike>,
): HomeDashboardCounts {
  const counts = { needs: 0, waiting: 0, done: 0, running: 0 };
  for (const row of rows) counts[row.section] += 1;
  return counts;
}

export function homeCountSegments(
  counts: HomeDashboardCounts,
): ReadonlyArray<{ readonly section: HomeDashboardSection; readonly text: string }> {
  return [
    ...(counts.needs > 0 ? [{ section: "needs" as const, text: `${counts.needs} need you` }] : []),
    ...(counts.waiting > 0
      ? [{ section: "waiting" as const, text: `${counts.waiting} waiting` }]
      : []),
    ...(counts.done > 0 ? [{ section: "done" as const, text: `${counts.done} done` }] : []),
    ...(counts.running > 0
      ? [{ section: "running" as const, text: `${counts.running} running` }]
      : []),
  ];
}

export function filterHomeDashboardRows<T extends HomeDashboardRowLike>(
  rows: ReadonlyArray<T>,
  section: HomeDashboardSection | "all",
  projectKey: string | "all",
): ReadonlyArray<T> {
  return rows.filter(
    (row) =>
      (section === "all" || row.section === section) &&
      (projectKey === "all" || row.projectKey === projectKey),
  );
}
