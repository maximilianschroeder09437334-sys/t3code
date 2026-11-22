import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import { makeThreadFixture } from "../../test-fixtures";
import {
  countHomeRows,
  deriveHomeRows,
  formatHomeCounts,
  formatHomeDuration,
  formatHomeTimeLabel,
  homeComposerProjectRef,
} from "./Home.logic";

const project = {
  environmentId: "environment-test",
  id: "project-test",
  displayName: "Project",
  archivedAt: null,
} as never;
const derive = (threads: ReturnType<typeof makeThreadFixture>[]) =>
  deriveHomeRows({
    threads,
    projects: [project],
    now: "2026-11-21T12:00:00Z",
    lastVisitedAt: null,
  });

describe("deriveHomeRows", () => {
  it("classifies active, completed and running threads and counts rows", () => {
    const rows = derive([
      makeThreadFixture({ id: ThreadId.make("need"), hasPendingUserInput: true }),
      makeThreadFixture({ id: ThreadId.make("done"), runtime: null }),
      makeThreadFixture({ id: ThreadId.make("run"), runtime: { status: "running" } as never }),
    ]);
    expect(rows.map((row) => [row.thread.id, row.section])).toEqual([
      ["need", "needs"],
      ["done", "done"],
      ["run", "running"],
    ]);
    expect(countHomeRows(rows)).toEqual({ needs: 1, waiting: 0, done: 1, running: 1 });
  });

  it("excludes archived, subagent, snoozed and settled threads as rows", () => {
    const rows = derive([
      makeThreadFixture({ id: ThreadId.make("archived"), archivedAt: "2026-11-20T00:00:00Z" }),
      makeThreadFixture({
        id: ThreadId.make("child"),
        lineage: {
          rootThreadId: ThreadId.make("child"),
          parentThreadId: ThreadId.make("parent"),
          relationshipToParent: "subagent",
        } as never,
      }),
      makeThreadFixture({ id: ThreadId.make("snoozed"), snoozedUntil: "2026-11-22T00:00:00Z" }),
      makeThreadFixture({ id: ThreadId.make("settled"), settledOverride: "settled" }),
    ]);
    expect(rows).toHaveLength(0);
  });

  it("matches the sidebar: drops subagent, side chat, delegated, settled and snoozed, keeps forks", () => {
    const lineage = (id: string, extra: Record<string, unknown>) =>
      ({
        rootThreadId: ThreadId.make("parent"),
        parentThreadId: ThreadId.make("parent"),
        relationshipToParent: null,
        ...extra,
      }) as never;
    const threads = [
      makeThreadFixture({ id: ThreadId.make("top") }),
      makeThreadFixture({
        id: ThreadId.make("fork"),
        lineage: lineage("fork", { relationshipToParent: "fork" }),
      }),
      makeThreadFixture({
        id: ThreadId.make("sub"),
        lineage: lineage("sub", { relationshipToParent: "subagent" }),
      }),
      makeThreadFixture({
        id: ThreadId.make("side"),
        lineage: lineage("side", { sideChat: true }),
      }),
      makeThreadFixture({ id: ThreadId.make("deleg") }),
      makeThreadFixture({ id: ThreadId.make("settled"), settledOverride: "settled" }),
      makeThreadFixture({ id: ThreadId.make("snoozed"), snoozedUntil: "2026-11-22T00:00:00Z" }),
    ];
    const rows = deriveHomeRows({
      threads,
      projects: [project],
      now: "2026-11-21T12:00:00Z",
      lastVisitedAt: null,
      delegatedUnderParent: new Set(["environment-test\u0000deleg"]),
    });
    expect(rows.map((row) => row.thread.id).sort()).toEqual(["fork", "top"]);
    expect(countHomeRows(rows)).toEqual({ needs: 0, waiting: 0, done: 2, running: 0 });
  });

  it("attaches older settled workstream threads to their unsettled successor", () => {
    const rows = derive([
      makeThreadFixture({
        id: ThreadId.make("old"),
        title: "Build: setup",
        settledOverride: "settled",
        updatedAt: "2026-11-20T00:00:00Z",
      }),
      makeThreadFixture({
        id: ThreadId.make("new"),
        title: "build: finish",
        updatedAt: "2026-11-21T00:00:00Z",
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.predecessors.map((thread) => thread.id)).toEqual(["old"]);
  });

  it("attaches settled predecessors only to the newest unsettled workstream row", () => {
    const rows = derive([
      makeThreadFixture({
        id: ThreadId.make("older-successor"),
        title: "Build: continue",
        updatedAt: "2026-11-21T00:00:00Z",
      }),
      makeThreadFixture({
        id: ThreadId.make("newer-successor"),
        title: "Build: finish",
        updatedAt: "2026-11-22T00:00:00Z",
      }),
      makeThreadFixture({
        id: ThreadId.make("settled-predecessor"),
        title: "Build: setup",
        settledOverride: "settled",
        updatedAt: "2026-11-20T00:00:00Z",
      }),
    ]);
    expect(rows[0]?.thread.id).toBe("newer-successor");
    expect(rows[0]?.predecessors.map((thread) => thread.id)).toEqual(["settled-predecessor"]);
    expect(rows[1]?.predecessors).toEqual([]);
  });
});

describe("Home display helpers", () => {
  it("hides zero count categories", () => {
    expect(formatHomeCounts({ needs: 0, waiting: 0, done: 14, running: 1 })).toBe(
      "14 done · 1 running",
    );
    expect(formatHomeCounts({ needs: 0, waiting: 0, done: 0, running: 0 })).toBe("");
  });

  it("formats waiting, running, completed, and stopped timestamps", () => {
    const now = "2026-11-21T14:00:00.000Z";
    expect(
      formatHomeTimeLabel(
        makeThreadFixture({
          hasPendingUserInput: true,
          pendingUserInputAt: "2026-11-21T13:52:00.000Z",
          updatedAt: "2026-11-21T13:52:00.000Z",
        }),
        now,
        "UTC",
      ),
    ).toBe("waiting on you for 8 min since 13:52");
    expect(
      formatHomeTimeLabel(
        makeThreadFixture({
          runtime: {
            status: "running",
            activeRunId: "run-home" as never,
            activityStartedAt: "2026-11-21T13:33:00.000Z",
          } as never,
          latestRun: {
            runId: "run-home",
            status: "running",
            requestedAt: "2026-11-21T13:33:00.000Z",
            startedAt: "2026-11-21T13:33:00.000Z",
            completedAt: null,
          } as never,
        }),
        now,
        "UTC",
      ),
    ).toBe("running 27 min");
    expect(
      formatHomeTimeLabel(
        makeThreadFixture({
          latestRun: { completedAt: "2026-11-21T13:52:00.000Z" } as never,
          updatedAt: "2026-11-21T13:52:00.000Z",
        }),
        now,
        "UTC",
      ),
    ).toBe("done 8 min ago");
    expect(
      formatHomeTimeLabel(
        makeThreadFixture({
          runtime: { status: "stopped" } as never,
          latestRun: {
            status: "cancelled",
            completedAt: "2026-11-21T13:47:00.000Z",
          } as never,
          updatedAt: "2026-11-21T13:47:00.000Z",
        }),
        now,
        "UTC",
      ),
    ).toBe("stopped 13 min ago");
    expect(
      formatHomeTimeLabel(
        makeThreadFixture({
          runtime: {
            status: "running",
            activeRunId: "run-long-home" as never,
            activityStartedAt: "2026-11-21T12:30:00.000Z",
          } as never,
        }),
        now,
        "UTC",
      ),
    ).toBe("running 2 h");
  });

  it("formats durations as rounded relative units with boundaries", () => {
    const f = formatHomeDuration;
    expect([f(0), f(1), f(59), f(59.7)]).toEqual(["0 min", "1 min", "59 min", "59 min"]);
    expect([f(60), f(217), f(23 * 60 + 40)]).toEqual(["1 h", "4 h", "23 h"]);
    expect([f(1440), f(2 * 1440), f(6.9 * 1440)]).toEqual(["1 day", "2 days", "6 days"]);
    expect([f(7 * 1440), f(14 * 1440), f(34 * 1440)]).toEqual(["1 week", "2 weeks", "4 weeks"]);
    expect([f(35 * 1440), f(4500), f(30000)]).toEqual(["1 month", "3 days", "3 weeks"]);
    expect([f(60 * 1440), f(359 * 1440), f(365 * 1440), f(800 * 1440)]).toEqual([
      "2 months",
      "11 months",
      "1 year",
      "2 years",
    ]);
  });

  it("drops the clock time when the wait began on an earlier day", () => {
    expect(
      formatHomeTimeLabel(
        makeThreadFixture({
          hasPendingUserInput: true,
          pendingUserInputAt: "2026-11-19T13:52:00.000Z",
          updatedAt: "2026-11-19T13:52:00.000Z",
        }),
        "2026-11-21T14:00:00.000Z",
        "UTC",
      ),
    ).toBe("waiting on you for 2 days");
  });

  it("maps the chosen project chip to the selected scoped project", () => {
    const projects = [
      {
        environmentId: "environment-one",
        id: "project-one",
        title: "One",
        archivedAt: null,
      },
      {
        environmentId: "environment-two",
        id: "project-two",
        title: "Two",
        archivedAt: null,
      },
    ] as never;
    expect(homeComposerProjectRef(projects, "environment-two:project-two")).toEqual({
      environmentId: "environment-two",
      projectId: "project-two",
    });
    expect(homeComposerProjectRef(projects, null)).toBeNull();
  });
});
