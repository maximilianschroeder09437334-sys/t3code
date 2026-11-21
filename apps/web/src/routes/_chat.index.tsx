import { createFileRoute } from "@tanstack/react-router";

import { NoProjectsHero } from "../components/NoProjectsHero";
import { HomeView } from "../components/home/HomeView";
import { HostedEmptyState } from "../components/HostedEmptyState";
import { useAllEnvironmentShellsBootstrapped, useProjects } from "../state/entities";
import { useEnvironments } from "../state/environments";

function ChatIndexRouteView() {
  const { authGateState } = Route.useRouteContext();
  const { environments, isReady } = useEnvironments();

  if (authGateState.status === "hosted-static") {
    if (!isReady) return null;
    if (environments.length === 0) return <HostedEmptyState />;
  }

  return <IndexDraftLanding />;
}

function IndexDraftLanding() {
  const projects = useProjects();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const hasProjects = projects.some((project) => project.archivedAt == null);
  // A pending environment cannot prove the workspace is empty.
  return !bootstrapped ? null : hasProjects ? <HomeView /> : <NoProjectsHero />;
}

export const Route = createFileRoute("/_chat/")({
  validateSearch: (raw: Record<string, unknown>): { item?: string } =>
    typeof raw.item === "string" ? { item: raw.item } : {},
  component: ChatIndexRouteView,
});
