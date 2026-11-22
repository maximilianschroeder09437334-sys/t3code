import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

export type HomeNotificationEvent = {
  readonly kind: "needs" | "done";
  readonly body: string;
  readonly runId: string;
};

export function isNewHomeNotificationEntry(
  previous: HomeNotificationEvent | null,
  next: HomeNotificationEvent | null,
  hasPreviousSnapshot: boolean,
): boolean {
  if (!hasPreviousSnapshot || next === null) return false;
  if (next.kind === "needs") return previous?.kind !== "needs";
  return previous?.kind !== "done" || previous.runId !== next.runId;
}

export function classifyHomeThreadNotification(
  thread: EnvironmentThreadShell,
  now: number,
): HomeNotificationEvent | null {
  if (
    thread.archivedAt !== null ||
    thread.deletedAt != null ||
    thread.settledOverride === "settled" ||
    thread.lineage.relationshipToParent === "subagent" ||
    thread.lineage.sideChat === true
  )
    return null;
  if (thread.snoozedUntil != null && Date.parse(thread.snoozedUntil) > now) return null;
  const runId = thread.latestRun?.runId ?? thread.id;
  if (thread.homeNeedsYou || thread.homeDashboardSection === "needs") {
    return { kind: "needs", body: thread.homeAskText ?? "Needs you", runId };
  }
  const firstStep = thread.homeFirstNextStep ?? "";
  const handedOff = /^T3:\s+\[[^\]]+\]\(https:\/\/app\.t3\.codes\/threads\/[^)]+\):/iu.test(
    firstStep,
  );
  const waiting =
    firstStep.startsWith("T3: WAIT on ") ||
    thread.blockedOnThreadWait === true ||
    thread.homeAutoWaitActive === true;
  if (
    thread.homeDashboardSection === "done" &&
    thread.latestRun?.status === "completed" &&
    !waiting &&
    !handedOff &&
    thread.homeHandedOff !== true &&
    (thread.pendingBackgroundTasks?.length ?? 0) === 0
  )
    return { kind: "done", body: `Done: ${thread.homeDoneText ?? "Task finished"}`, runId };
  return null;
}
