import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import { makeThreadFixture } from "../../test-fixtures";
import {
  countHomeRows,
  deriveHomeRows,
  formatHomeCounts,
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
    expect(countHomeRows(rows)).toEqual({ needs: 1, done: 1, running: 1 });
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
    expect(formatHomeCounts({ needs: 0, done: 14, running: 1 })).toBe("14 done · 1 running");
    expect(formatHomeCounts({ needs: 0, done: 0, running: 0 })).toBe("");
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
    ).toBe("waiting on you since 13:52 (8m)");
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
    ).toBe("running 27m");
    expect(
      formatHomeTimeLabel(
        makeThreadFixture({
          latestRun: { completedAt: "2026-11-21T13:52:00.000Z" } as never,
          updatedAt: "2026-11-21T13:52:00.000Z",
        }),
        now,
        "UTC",
      ),
    ).toBe("done 8m ago");
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
    ).toBe("stopped 13:47");
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
    ).toBe("running 90m");
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
