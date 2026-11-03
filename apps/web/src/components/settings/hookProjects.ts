import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import type { ResolvedSettingsScope } from "./settingsScope";
import type { HookDefinition } from "@t3tools/contracts";

/** Resolve read targets without widening an unavailable or explicitly selected scope. */
export function hookProjectsForScope(
  scope: ResolvedSettingsScope,
  groups: readonly SidebarProjectSnapshot[],
): SidebarProjectGroupMember[] {
  const members =
    scope.kind === "unavailable"
      ? []
      : scope.kind === "project" || scope.kind === "checkout"
        ? scope.members
        : groups
            .flatMap((group) => group.memberProjects)
            .filter((member) => scope.environmentIds.includes(member.environmentId));
  return [...new Map(members.map((member) => [member.physicalProjectKey, member])).values()];
}

/** Archived projects stay addressable when explicitly selected, but do not clutter the overview. */
export function visibleHookProjects(
  scope: ResolvedSettingsScope,
  groups: readonly SidebarProjectSnapshot[],
  projects: readonly SidebarProjectGroupMember[],
): SidebarProjectGroupMember[] {
  if (scope.kind === "project" || scope.kind === "checkout") return [...projects];
  const activeKeys = new Set(
    groups
      .filter((group) => !group.archived)
      .flatMap((group) => group.memberProjects.map((member) => member.physicalProjectKey)),
  );
  return projects.filter((project) => activeKeys.has(project.physicalProjectKey));
}

/** Shared hooks are stored per environment, not per project or checkout. */
export function hookEnvironmentRepresentatives(
  projects: readonly SidebarProjectGroupMember[],
): SidebarProjectGroupMember[] {
  const byEnvironment = new Map<
    SidebarProjectGroupMember["environmentId"],
    SidebarProjectGroupMember
  >();
  for (const project of projects) {
    if (!byEnvironment.has(project.environmentId))
      byEnvironment.set(project.environmentId, project);
  }
  return [...byEnvironment.values()];
}

export function hooksInScope(
  hooks: readonly HookDefinition[],
  scope: "all-projects" | "project",
): HookDefinition[] {
  return hooks.filter((hook) => (hook.scope ?? "project") === scope);
}
