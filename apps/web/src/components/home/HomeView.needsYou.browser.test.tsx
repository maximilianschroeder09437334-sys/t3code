import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";
import { makeThreadFixture } from "../../test-fixtures";
import { HomeView } from "./HomeView";

// Set VITE_T3_PROOF_DIR (a folder inside the repo, which Vite may write to) to also save a PNG.
const PROOF_DIR: string | undefined = import.meta.env.VITE_T3_PROOF_DIR;

const state = vi.hoisted(() => ({
  threads: [] as ReadonlyArray<unknown>,
  projects: [] as ReadonlyArray<unknown>,
}));
vi.mock("../ChatView", () => ({ default: () => null }));
// Synchronous stubs: spreading the real state modules from an async factory hits their import
// cycles. Exports Home does not read only need to exist for the module graph to link.
vi.mock("../../state/entities", () => ({
  ...Object.fromEntries(
    [
      "useThreadRefs",
      "useEnvironmentThreadRefs",
      "useProjects",
      "useServerConfigs",
      "useThreadShells",
      "useAnyEnvironmentHiding",
      "useHiddenThreadKeys",
      "useVisibleThreadShells",
      "useAllEnvironmentShellsBootstrapped",
      "useAllEnvironmentProjectSnapshotsReady",
      "useDelegatedUnderParent",
      "useThreadShellsForProjectRefs",
      "useProject",
      "useThreadShell",
      "useQuietThreadShell",
      "useQuietThreadShells",
      "useChildThreadInputs",
      "useThreadProjection",
      "useQuietThreadProjection",
      "useThreadLastVisitedAt",
      "useThreadUpdatedAt",
      "useThreadStatus",
      "useThreadHistory",
      "resolveThreadDetailRef",
      "useThreadVisibleTurnItems",
      "useTimelineVisibleTurnItems",
      "useAssistantMessageText",
      "useQuietThreadVisibleTurnItems",
      "useThreadCheckpointSummaries",
      "readProject",
      "subscribeProject",
      "readProjects",
      "waitForProject",
      "waitForProjectRemoval",
      "readThreadTurnItems",
      "readThreadShell",
      "waitForThreadShell",
      "useEnvironmentSupportsServerBrowser",
      "readEnvironmentSupportsServerBrowser",
      "readEnvironmentServerConfigLoaded",
      "readEnvironmentSupportsAutoSettleOptOut",
      "readEnvironmentThreadRefs",
      "readThreadShells",
      "readDelegatedUnderParent",
      "selectThreadRelationshipShells",
      "useThreadRelationshipShells",
      "readEnvironmentSupportsThreadNotifications",
      "readResponseSubagents",
    ].map((name) => [name, () => undefined]),
  ),
  useProjects: () => state.projects,
  readProjects: () => state.projects,
  useVisibleThreadShells: () => state.threads,
  useThreadShells: () => state.threads,
  readThreadShells: () => state.threads,
  useQuietThreadShells: () => [],
  useDelegatedUnderParent: () => new Set(),
}));
vi.mock("../../state/environments", () => ({
  useEnvironmentProviders: () => new Map(),
  useEnvironments: () => ({ environments: [] }),
  useEnvironment: () => null,
  usePrimaryEnvironment: () => null,
  usePrimaryEnvironmentId: () => null,
  readEnvironment: () => null,
  useConnectedEnvironmentIds: () => [],
  useEnvironmentHttpBaseUrl: () => null,
  useEnvironmentIdentities: () => new Map(),
  useEnvironmentMachines: () => new Map(),
  usePullRequestsSupported: () => true,
  useRelayEnvironmentDiscovery: () => null,
}));
vi.mock("../../hooks/useThreadActions", () => ({
  ...Object.fromEntries(
    [
      "ThreadArchiveBlockedError",
      "ThreadSettlementUnsupportedError",
      "ThreadSnoozeUnsupportedError",
      "ThreadSnoozeBlockedError",
      "ThreadAutoSettleOptOutUnsupportedError",
      "ThreadPinningUnsupportedError",
      "ThreadPinReorderUnsupportedError",
      "ThreadActiveReorderUnsupportedError",
    ].map((name) => [name, class extends Error {}]),
  ),
  navigateAfterThreadDeletion: () => undefined,
  useAcknowledgeThreadWoke: () => () => undefined,
  canTurnThreadIntoProject: () => false,
  useThreadActions: () => ({ settleThread: () => Promise.resolve() }),
}));
vi.mock("../../hooks/useScratchProject", () => ({
  createScratchProjectActions: () => ({}),
  useScratchProject: () => ({ scratchEnvironmentId: () => null, openScratchProject: () => {} }),
}));
vi.mock("../../hooks/useNowMinute", () => ({ useNowMinute: () => "2026-11-27T12:00" }));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => () => Promise.resolve({ _tag: "Success" }),
}));

const environmentId = EnvironmentId.make("environment-test");
const waitStep = (title: string, threadId: string) =>
  `T3: WAIT on [${title}](https://app.t3.codes/threads/${environmentId}/${threadId})`;
const shell = (id: string, title: string, overrides: Record<string, unknown>) =>
  makeThreadFixture({
    id: ThreadId.make(id),
    title,
    runtime: null,
    updatedAt: "2026-11-27T11:30:00.000Z",
    ...overrides,
  } as never);

function setup() {
  state.projects = [
    {
      environmentId,
      id: ProjectId.make("project-test"),
      title: "T3 Code",
      displayName: "T3 Code",
      workspaceRoot: "/repo",
      archivedAt: null,
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-27T11:00:00.000Z",
    },
  ];
  state.threads = [
    shell("release", "Release: review the Home layout", {
      homeFirstNextStep: "Maxi: approve the Home layout",
      homeAskText: "approve the Home layout",
      homeNeedsYou: true,
      homeDashboardSection: "needs",
    }),
    shell("pipeline", "Pipeline: gate run", {
      homeFirstNextStep: waitStep("Release: review the Home layout", "release"),
      homeDashboardSection: "waiting",
    }),
    shell("docs", "Docs: guide pass", {
      homeFirstNextStep: "Maxi: nothing needed right now.",
      homeDashboardSection: "done",
    }),
    shell("mobile", "Mobile: build", {
      homeFirstNextStep: waitStep("Docs: guide pass", "docs"),
      homeDashboardSection: "waiting",
    }),
  ];
}

it("lists Maxi's ask and marks only waits whose target needs Maxi", async () => {
  setup();
  await page.viewport(1280, 800);
  await using screen = await render(<HomeView />);

  await expect.element(screen.getByText("approve the Home layout")).toBeVisible();
  const needsTarget = screen.getByRole("link", { name: "Release: review the Home layout" });
  await expect.element(needsTarget).toHaveAttribute("href", "/environment-test/release");
  expect(needsTarget.element().parentElement?.textContent).toContain("needs you");

  const quietTarget = screen.getByRole("link", { name: "Docs: guide pass" });
  await expect.element(quietTarget).toHaveAttribute("href", "/environment-test/docs");
  expect(quietTarget.element().parentElement?.textContent).not.toContain("needs you");

  if (PROOF_DIR) await page.screenshot({ path: `${PROOF_DIR}/3.1-home-needs-you-1280x800.png` });
});
