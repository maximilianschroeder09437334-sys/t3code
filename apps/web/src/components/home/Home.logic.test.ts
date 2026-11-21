import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import { makeThreadFixture } from "../../test-fixtures";
import { countHomeRows, deriveHomeRows } from "./Home.logic";

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
