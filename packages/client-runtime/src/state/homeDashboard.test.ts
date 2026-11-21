import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentProject, EnvironmentThreadShell } from "./models.ts";

import {
  countHomeDashboardRows,
  deriveHomeDashboardRows,
  filterHomeDashboardRows,
  homeCountSegments,
} from "./homeDashboard.ts";

const rows = [
  { id: "need-a", section: "needs", projectKey: "a" },
  { id: "done-a", section: "done", projectKey: "a" },
  { id: "run-b", section: "running", projectKey: "b" },
] as const;
const environmentId = EnvironmentId.make("home-test");
const projectId = ProjectId.make("project-home");
const project = {
  environmentId,
  id: projectId,
  title: "Home project",
  archivedAt: null,
} as EnvironmentProject;
const thread = (id: string, overrides: Record<string, unknown> = {}) =>
  ({
    environmentId,
    projectId,
    id: ThreadId.make(id),
    title: id,
    updatedAt: "2026-11-21T10:00:00.000Z",
    latestUserMessageAt: null,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    snoozedUntil: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    pendingGuestMessageCount: 0,
    runtime: null,
    blockedOnThreadWait: false,
    lineage: {
      rootThreadId: ThreadId.make(id),
      parentThreadId: null,
      relationshipToParent: null,
      sideChat: false,
    },
    ...overrides,
  }) as unknown as EnvironmentThreadShell;

describe("Home dashboard helpers", () => {
  it("counts each section and naturally leaves empty sections at zero", () => {
    expect(countHomeDashboardRows(rows)).toEqual({ needs: 1, done: 1, running: 1 });
    expect(countHomeDashboardRows([])).toEqual({ needs: 0, done: 0, running: 0 });
  });

  it("hides zero counts from the pinned Home row", () => {
    expect(homeCountSegments({ needs: 0, done: 14, running: 1 })).toEqual([
      { section: "done", text: "14 done" },
      { section: "running", text: "1 running" },
    ]);
    expect(homeCountSegments({ needs: 0, done: 0, running: 0 })).toEqual([]);
  });

  it("filters by section and project together", () => {
    expect(filterHomeDashboardRows(rows, "needs", "a").map((row) => row.id)).toEqual(["need-a"]);
    expect(filterHomeDashboardRows(rows, "all", "b").map((row) => row.id)).toEqual(["run-b"]);
    expect(filterHomeDashboardRows(rows, "done", "all").map((row) => row.id)).toEqual(["done-a"]);
  });

  it("derives only top-level, active and unsnoozed rows with shared status grouping", () => {
    const active = deriveHomeDashboardRows({
      projects: [project],
      now: "2026-11-21T12:00:00.000Z",
      threads: [
        thread("need", { hasPendingUserInput: true }),
        thread("running", { runtime: { status: "running" } }),
        thread("settled", { settledOverride: "settled" }),
        thread("snoozed", { snoozedUntil: "2026-11-22T00:00:00.000Z" }),
        thread("subagent", {
          lineage: {
            rootThreadId: ThreadId.make("subagent"),
            parentThreadId: ThreadId.make("parent"),
            relationshipToParent: "subagent",
          },
        }),
      ],
    });
    expect(active.map((row) => [row.thread.id, row.section, row.projectName])).toEqual([
      ["need", "needs", "Home project"],
      ["running", "running", "Home project"],
    ]);
  });
});
