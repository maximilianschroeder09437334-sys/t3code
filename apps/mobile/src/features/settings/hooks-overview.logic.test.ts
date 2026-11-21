import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { hooksForSection, sharedHookTargets, visibleHookTargets } from "./hooks-overview.logic";

describe("mobile hook overview", () => {
  it("loads shared hooks once per environment and separates project hooks", () => {
    const pc = EnvironmentId.make("pc");
    const other = EnvironmentId.make("other");
    const projects = [
      { project: { environmentId: pc }, name: "first" },
      { project: { environmentId: pc }, name: "second" },
      { project: { environmentId: other }, name: "third" },
    ];
    expect(sharedHookTargets(projects).map((entry) => entry.name)).toEqual(["first", "third"]);
    const hooks = [
      { id: "shared", scope: "all-projects" as const },
      { id: "local", scope: "project" as const },
      { id: "legacy" },
    ];
    expect(hooksForSection(hooks, "all-projects").map((hook) => hook.id)).toEqual(["shared"]);
    expect(hooksForSection(hooks, "project").map((hook) => hook.id)).toEqual(["local", "legacy"]);
  });

  it("hides archived projects in the overview while retaining explicit selections and shared hooks", () => {
    const pc = EnvironmentId.make("pc");
    const projects = [
      { project: { environmentId: pc, archivedAt: "2026-11-01" }, name: "archived" },
      { project: { environmentId: pc, archivedAt: null }, name: "active" },
    ];
    const visible = visibleHookTargets(projects, false);
    expect(visible.map((entry) => entry.name)).toEqual(["active"]);
    expect(sharedHookTargets([...visible, ...projects])[0]?.name).toBe("active");
    expect(visibleHookTargets(projects, true)).toEqual(projects);
    expect(visibleHookTargets(projects.slice(0, 1), false)).toEqual([]);
    expect(sharedHookTargets(projects.slice(0, 1))).toHaveLength(1);
  });
});
