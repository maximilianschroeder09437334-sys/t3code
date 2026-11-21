import type { EnvironmentId, HookDefinition } from "@t3tools/contracts";

/** One project per environment is enough to load its shared hooks. */
export function sharedHookTargets<T extends { project: { environmentId: EnvironmentId } }>(
  projects: readonly T[],
): T[] {
  const seen = new Set<EnvironmentId>();
  return projects.filter(({ project }) => {
    if (seen.has(project.environmentId)) return false;
    seen.add(project.environmentId);
    return true;
  });
}

/** Explicitly selected archived projects remain accessible, but are hidden from the overview. */
export function visibleHookTargets<T extends { project: { archivedAt?: unknown } }>(
  projects: readonly T[],
  hasExplicitProject: boolean,
): T[] {
  return hasExplicitProject
    ? [...projects]
    : projects.filter(({ project }) => project.archivedAt == null);
}

export function hooksForSection<T extends Pick<HookDefinition, "scope">>(
  hooks: readonly T[],
  scope: "all-projects" | "project",
): T[] {
  return hooks.filter((hook) => (hook.scope ?? "project") === scope);
}
