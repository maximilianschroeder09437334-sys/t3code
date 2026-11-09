import { EnvironmentId, ProjectId, type HookDefinition } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import {
  resolveSettingsScope,
  singleScopedProject,
  validateSettingsScopeSearch,
} from "./settingsScope";
import {
  hookEnvironmentRepresentatives,
  hookProjectsForScope,
  hooksInScope,
  visibleHookProjects,
} from "./hookProjects";

const laptopId = EnvironmentId.make("laptop");
const serverId = EnvironmentId.make("server");
const environments = [
  { environmentId: laptopId, label: "Laptop" },
  { environmentId: serverId, label: "Server" },
];

function member(id: string, environmentId: EnvironmentId): SidebarProjectGroupMember {
  return {
    id: ProjectId.make(id),
    environmentId,
    title: "T3 Code",
    workspaceRoot: `/repos/${id}`,
    physicalProjectKey: `${environmentId}:/repos/${id}`,
    environmentLabel:
      environments.find((environment) => environment.environmentId === environmentId)?.label ??
      null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
  };
}

const first = member("first", laptopId);
const second = member("second", laptopId);
const third = member("third", serverId);
const other = member("other", serverId);

function group(
  projectKey: string,
  members: readonly SidebarProjectGroupMember[],
): SidebarProjectSnapshot {
  return {
    ...members[0]!,
    projectKey,
    displayName: projectKey,
    memberProjects: members,
    memberProjectRefs: members.map((project) => ({
      environmentId: project.environmentId,
      projectId: project.id,
    })),
    groupedProjectCount: members.length,
    environmentPresence: "mixed",
    allRemoteMembersAreDesktopLocal: false,
    allRemoteMembersAreWsl: false,
    remoteEnvironmentLabels: [],
    pinned: false,
    archived: false,
  };
}

const groups = [group("t3code", [first, second, third]), group("other", [other])];

describe("hook overview targets", () => {
  it("hides archived projects in the overview while retaining shared and explicitly selected hooks", () => {
    const archived = { ...group("other", [other]), archived: true };
    const mixedGroups = [groups[0]!, archived];
    const allScope = resolveSettingsScope({}, mixedGroups, environments);
    const allProjects = hookProjectsForScope(allScope, mixedGroups);
    const visible = visibleHookProjects(allScope, mixedGroups, allProjects);
    expect(visible).toEqual([first, second, third]);
    expect(hookEnvironmentRepresentatives([...visible, ...allProjects])).toEqual([first, third]);
    const archivedScope = resolveSettingsScope({ project: "other" }, mixedGroups, environments);
    expect(
      visibleHookProjects(
        archivedScope,
        mixedGroups,
        hookProjectsForScope(archivedScope, mixedGroups),
      ),
    ).toEqual([other]);
    const onlyArchived = [archived];
    const onlyScope = resolveSettingsScope({}, onlyArchived, environments);
    const targets = hookProjectsForScope(onlyScope, onlyArchived);
    expect(visibleHookProjects(onlyScope, onlyArchived, targets)).toEqual([]);
    expect(hookEnvironmentRepresentatives(targets)).toEqual([other]);
  });
  it("shows shared hooks once per environment and keeps project hooks separate", () => {
    expect(hookEnvironmentRepresentatives([first, second, third, other])).toEqual([first, third]);
    const base: HookDefinition = {
      id: "shared",
      projectId: first.id,
      name: "Shared hook",
      event: "turn_end",
      script: "return { decision: 'allow' };",
      scriptSha256: "a".repeat(64),
      status: "draft",
      enabled: false,
      createdAt: 0,
      scope: "all-projects",
    };
    const projectHook: HookDefinition = { ...base, id: "project", scope: "project" };
    const { scope: _scope, ...legacy } = base;
    const legacyHook: HookDefinition = { ...legacy, id: "legacy" };
    expect(hooksInScope([base, projectHook, legacyHook], "all-projects")).toEqual([base]);
    expect(hooksInScope([base, projectHook, legacyHook], "project")).toEqual([
      projectHook,
      legacyHook,
    ]);
  });
  it("shows all projects, filters environments, and keeps a selected project narrow", () => {
    expect(hookProjectsForScope(resolveSettingsScope({}, groups, environments), groups)).toEqual([
      first,
      second,
      third,
      other,
    ]);
    expect(
      hookProjectsForScope(
        resolveSettingsScope({ machine: laptopId }, groups, environments),
        groups,
      ),
    ).toEqual([first, second]);
    expect(
      hookProjectsForScope(
        resolveSettingsScope({ project: "other" }, groups, environments),
        groups,
      ),
    ).toEqual([other]);
    expect(
      hookProjectsForScope(
        resolveSettingsScope({ project: "missing" }, groups, environments),
        groups,
      ),
    ).toEqual([]);
  });
});

describe("settings scope search", () => {
  it("retains an orphan checkout so it cannot turn into all environments", () => {
    const search = validateSettingsScopeSearch({ checkout: first.physicalProjectKey });
    expect(search).toEqual({ checkout: first.physicalProjectKey });
    expect(resolveSettingsScope(search, groups, environments)).toMatchObject({
      kind: "unavailable",
      reason: "project-required",
      members: [],
      environmentIds: [],
    });
  });
});

describe("settings scope resolution", () => {
  it("keeps all physical members in a project aggregate, including several on one environment", () => {
    expect(resolveSettingsScope({ project: "t3code" }, groups, environments)).toMatchObject({
      kind: "project",
      environmentId: null,
      members: [first, second, third],
      environmentIds: [laptopId, serverId],
    });
  });

  it("narrows a checkout target to exactly one member, deriving its environment when omitted", () => {
    expect(
      resolveSettingsScope(
        { project: "t3code", checkout: second.physicalProjectKey },
        groups,
        environments,
      ),
    ).toMatchObject({
      kind: "checkout",
      checkout: second,
      environmentId: laptopId,
      label: "t3code / Laptop · /repos/second",
      members: [second],
      environmentIds: [laptopId],
    });
  });

  it.each([
    { project: "missing" },
    { machine: "removed" },
    { project: "t3code", machine: "removed" },
    { project: "t3code", checkout: "deleted" },
    { project: "other", machine: laptopId },
    { project: "other", checkout: first.physicalProjectKey },
    { project: "t3code", machine: serverId, checkout: first.physicalProjectKey },
  ])("never widens an invalid or stale target: %j", (search) => {
    expect(resolveSettingsScope(search, groups, environments)).toMatchObject({
      kind: "unavailable",
      members: [],
      environmentIds: [],
    });
  });

  it("leaves a removed checkout unavailable while sibling checkouts remain", () => {
    const search = {
      project: "t3code",
      machine: laptopId,
      checkout: first.physicalProjectKey,
    };
    expect(resolveSettingsScope(search, groups, environments)).toMatchObject({
      kind: "checkout",
      members: [first],
    });
    expect(
      resolveSettingsScope(search, [group("t3code", [second, third])], environments),
    ).toMatchObject({ kind: "unavailable", members: [], environmentIds: [] });
  });

  it("does not select another environment after removing a project's last local checkout", () => {
    const search = { project: "t3code", machine: laptopId };
    expect(resolveSettingsScope(search, groups, environments)).toMatchObject({
      kind: "project",
      members: [first, second],
    });
    expect(resolveSettingsScope(search, [group("t3code", [third])], environments)).toMatchObject({
      kind: "unavailable",
      members: [],
      environmentIds: [],
    });
  });

  it("rejects a cached checkout whose environment was removed", () => {
    expect(
      resolveSettingsScope(
        { project: "t3code", checkout: third.physicalProjectKey },
        groups,
        environments.slice(0, 1),
      ),
    ).toMatchObject({
      kind: "unavailable",
      reason: "environment-missing",
      members: [],
      environmentIds: [],
    });
  });
});

describe("single scoped project", () => {
  it("requires an unambiguous project even when multiple checkouts share an environment", () => {
    expect(
      singleScopedProject(
        resolveSettingsScope({ project: "t3code", machine: laptopId }, groups, environments),
      ),
    ).toBeNull();
    expect(
      singleScopedProject(
        resolveSettingsScope({ project: "t3code", machine: serverId }, groups, environments),
      ),
    ).toEqual(third);
    expect(
      singleScopedProject(
        resolveSettingsScope(
          { project: "t3code", checkout: second.physicalProjectKey },
          groups,
          environments,
        ),
      ),
    ).toEqual(second);
    expect(singleScopedProject(resolveSettingsScope({}, groups, environments))).toBeNull();
    expect(
      singleScopedProject(resolveSettingsScope({ project: "missing" }, groups, environments)),
    ).toBeNull();
  });
});
