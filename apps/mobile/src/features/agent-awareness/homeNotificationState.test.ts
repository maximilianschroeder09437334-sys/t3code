import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";

import {
  classifyHomeThreadNotification,
  isNewHomeNotificationEntry,
} from "./homeNotificationState";

type ThreadOverrides = Omit<
  Partial<EnvironmentThreadShell>,
  "latestRun" | "pendingBackgroundTasks"
> & {
  readonly latestRun?: { readonly runId: string; readonly status: string } | null;
  readonly pendingBackgroundTasks?: ReadonlyArray<unknown>;
};

function thread(overrides: ThreadOverrides = {}): EnvironmentThreadShell {
  return {
    id: "thread-1",
    environmentId: "environment-1",
    title: "Build thread",
    lineage: { rootThreadId: "thread-1", parentThreadId: null, relationshipToParent: null },
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    snoozedUntil: null,
    latestRun: { runId: "run-1", status: "running" },
    homeNeedsYou: false,
    homeDashboardSection: "running",
    pendingBackgroundTasks: [],
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

describe("classifyHomeThreadNotification", () => {
  it("alerts for a current Maxi ask while work continues", () => {
    expect(
      classifyHomeThreadNotification(
        thread({
          homeNeedsYou: true,
          homeDashboardSection: "needs",
          homeAskText: "Review this build",
        }),
        0,
      ),
    ).toMatchObject({ kind: "needs", body: "Review this build" });
  });

  it("ignores a stale ask while a newer run is active", () => {
    expect(
      classifyHomeThreadNotification(
        thread({ homeAskText: "Old ask", latestRun: { runId: "run-2", status: "running" } }),
        0,
      ),
    ).toBeNull();
  });

  it("alerts for done only when no wait, successor or child remains", () => {
    const done = thread({
      latestRun: { runId: "run-1", status: "completed" },
      homeDashboardSection: "done",
      homeDoneText: "Build finished",
    });
    expect(classifyHomeThreadNotification(done, 0)).toMatchObject({
      kind: "done",
      body: "Done: Build finished",
    });
    expect(
      classifyHomeThreadNotification(
        {
          ...done,
          homeFirstNextStep: "T3: WAIT on [Build](https://app.t3.codes/threads/env/thread)",
        },
        0,
      ),
    ).toBeNull();
    expect(classifyHomeThreadNotification({ ...done, homeHandedOff: true }, 0)).toBeNull();
    expect(
      classifyHomeThreadNotification(
        {
          ...done,
          pendingBackgroundTasks: [{ kind: "subagent" }],
        } as unknown as EnvironmentThreadShell,
        0,
      ),
    ).toBeNull();
  });
});

it("notifies once on entry, including from a prior non-attention snapshot", () => {
  const needs = { kind: "needs", body: "Review", runId: "run-1" } as const;
  const done = { kind: "done", body: "Done: Ready", runId: "run-1" } as const;
  expect(isNewHomeNotificationEntry(null, needs, false)).toBe(false);
  expect(isNewHomeNotificationEntry(null, needs, true)).toBe(true);
  expect(isNewHomeNotificationEntry(needs, { ...needs, body: "Updated wording" }, true)).toBe(
    false,
  );
  expect(isNewHomeNotificationEntry(null, done, true)).toBe(true);
  expect(isNewHomeNotificationEntry(done, done, true)).toBe(false);
  expect(isNewHomeNotificationEntry(done, { ...done, runId: "run-2" }, true)).toBe(true);
});
