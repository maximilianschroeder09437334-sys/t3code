import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ThreadRuntimeSummary } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { createElement, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";
import { cn } from "../../lib/utils";
import { makeThreadFixture } from "../../test-fixtures";
import type { SidebarThreadSummary } from "../../types";
import { Sidebar, SidebarContent, SidebarGroup, SidebarProvider } from "../ui/sidebar";
import { SidebarChromeFooter } from "./SidebarChrome";
import {
  APP_SIDEBAR_PROVIDER_CLASS,
  THREAD_SIDEBAR_CONTENT_CLASS,
  THREAD_SIDEBAR_LIST_CLASS,
  THREAD_SIDEBAR_LIST_GROUP_CLASS,
} from "./sidebarLayoutClasses";
import { SortableThreadRow } from "./SidebarThreadRow";

// Set VITE_T3_PROOF_DIR (a folder inside the repo, which Vite may write to) to also save one PNG
// per viewport there.
const PROOF_DIR: string | undefined = import.meta.env.VITE_T3_PROOF_DIR;

const state = vi.hoisted(() => ({ presentations: new Map<string, unknown>() }));
vi.mock("@effect/atom-react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@effect/atom-react")>();
  const useOriginalAtomValue = original.useAtomValue as (
    ...args: ReadonlyArray<unknown>
  ) => unknown;
  return {
    ...original,
    useAtomValue: ((atom: unknown, ...rest: ReadonlyArray<unknown>) =>
      atom === "presentations"
        ? state.presentations
        : atom === "keys"
          ? []
          : useOriginalAtomValue(atom, ...rest)) as never,
  };
});
vi.mock("../../state/presentation", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../state/presentation")>();
  return {
    ...original,
    // The rows read the other presentation atoms for real.
    environmentPresentations: {
      ...original.environmentPresentations,
      presentationsWithProvidersAtom: "presentations",
    },
  };
});
vi.mock("../../state/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/server")>()),
  primaryServerKeybindingsAtom: "keys",
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => () => Promise.resolve() }));
vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
  usePullRequestsSupported: () => true,
}));
vi.mock("../../hooks/useNowMinute", () => ({ useNowMinute: () => "2026-11-05T12:00" }));
vi.mock("./SidebarProviderUpdatePill", () => ({ SidebarProviderUpdatePill: () => null }));
vi.mock("./SidebarUpdatePill", () => ({
  SidebarUpdatePill: () => null,
  SidebarUpdateArchitectureWarning: () => null,
}));
vi.mock("./SidebarThreadUndoNotice", () => ({ SidebarThreadUndoNotice: () => null }));
vi.mock("./mainAppLocation", () => ({
  isSidebarUtilityPage: () => false,
  useNavigateToMainApp: () => () => {},
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => () => {},
  useLocation: ({ select }: { select: (location: { pathname: string }) => unknown }) =>
    select({ pathname: "/" }),
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) =>
    createElement("a", { ...props, href: to }, children),
}));

const env = EnvironmentId.make("environment-test");
const THREAD_COUNT = 60;

const runtime = (status: ThreadRuntimeSummary["status"]): ThreadRuntimeSummary => ({
  status,
  activeRunId: null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: "Codex",
  lastError: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
});

type RowKind = "working" | "snoozed" | "idle";
// Every third row works and every fourth is snoozed; the list ends Working then Snoozed.
const rowKind = (index: number): RowKind =>
  index === THREAD_COUNT - 1
    ? "snoozed"
    : index === THREAD_COUNT - 2 || index % 3 === 0
      ? "working"
      : index % 4 === 0
        ? "snoozed"
        : "idle";

const rows = Array.from({ length: THREAD_COUNT }, (_, index) => {
  const kind = rowKind(index);
  const thread = makeThreadFixture({
    environmentId: env,
    id: ThreadId.make(`thread-${index + 1}`),
    title: `Thread ${index + 1} ${kind}`,
    ...(kind === "working" ? { runtime: runtime("running") } : {}),
  }) as SidebarThreadSummary;
  return { kind, thread, key: scopedThreadKey(scopeThreadRef(env, thread.id)) };
});

function setup() {
  state.presentations = new Map([
    [
      "test-env",
      {
        entry: { target: { label: "Offline fixture" } },
        connection: { phase: "connected" },
        serverConfig: {
          providers: [
            {
              instanceId: "codex",
              driver: "codex",
              enabled: true,
              installed: true,
              status: "ready",
              auth: { status: "authenticated" },
              checkedAt: "2026-11-05T11:59:00Z",
              models: [],
              slashCommands: [],
              skills: [],
              usageLimits: {
                checkedAt: "2026-11-05T11:59:00Z",
                windows: [
                  {
                    id: "weekly",
                    kind: "weekly",
                    label: "Weekly",
                    usedPercent: 24,
                    windowDurationMins: 10080,
                    resetsAt: "2026-11-11T07:00:00Z",
                  },
                ],
              },
            },
          ],
        },
      },
    ],
  ]);
}

const noop = () => {};

// The chain the app builds: AppSidebarLayout's provider and Sidebar, then ThreadSidebar's
// scrolling content, row list and footer. Classes come from the module both components use.
function ProductionShapedSidebar() {
  return (
    <SidebarProvider className={APP_SIDEBAR_PROVIDER_CLASS}>
      <Sidebar side="left" collapsible="offcanvas" role="navigation" aria-label="Threads">
        <SidebarContent className={THREAD_SIDEBAR_CONTENT_CLASS}>
          <SidebarGroup className={THREAD_SIDEBAR_LIST_GROUP_CLASS} role="presentation">
            <DndContext>
              <SortableContext items={rows.map((row) => row.key)}>
                <ul role="presentation" className={cn(THREAD_SIDEBAR_LIST_CLASS, "flex-1")}>
                  {rows.map(({ kind, thread, key }) => (
                    <SortableThreadRow
                      key={key}
                      sortableId={key}
                      sortableDisabled
                      contextDrag={false}
                      thread={thread}
                      variant="card"
                      variantAction={kind === "snoozed" ? "unsnooze" : "settle"}
                      settlementSupported
                      snoozeSupported
                      pinningSupported={false}
                      isPinned={false}
                      dropVerb={null}
                      dragOverPinned={false}
                      sweepAction={null}
                      snoozeWakeLabelText={kind === "snoozed" ? "Wakes 3 PM" : null}
                      wokeAt={null}
                      isActive={false}
                      isRouteThread={false}
                      readOpensPullRequestsInRightPanel={() => false}
                      jumpLabel={null}
                      currentEnvironmentId={env}
                      environmentLabel={null}
                      environmentMachine="server"
                      scratchMachineLabel={null}
                      project={null}
                      projectDisplayName="Project"
                      providerEntryByInstanceId={new Map()}
                      timestampFormat="locale"
                      onCommitRename={noop}
                      onCancelRename={noop}
                      onRenameTitleChange={noop}
                      isRenaming={false}
                      renamingTitle=""
                      onSettle={noop}
                      onActionSweepStart={noop}
                      onUnsettle={noop}
                      onSnooze={noop}
                      onUnsnooze={noop}
                      onUnpin={noop}
                      onAcknowledgeWoke={noop}
                      onThreadClick={noop}
                      onThreadActivate={noop}
                      onStartRename={noop}
                      onContextMenu={noop}
                    />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
          </SidebarGroup>
        </SidebarContent>
        <SidebarChromeFooter />
      </Sidebar>
    </SidebarProvider>
  );
}

it.for([
  { name: "desktop", width: 1440, height: 900 },
  { name: "ipad-portrait", width: 820, height: 1180 },
  { name: "ipad-landscape", width: 1180, height: 820 },
])(
  "keeps the last thread row above the usage bar when scrolled to the end ($name)",
  async ({ name, width, height }) => {
    setup();
    await page.viewport(width, height);
    await using screen = await render(<ProductionShapedSidebar />, { router: false });
    await expect.element(screen.getByText("Codex Weekly")).toBeVisible();

    const footer = screen.container.querySelector<HTMLElement>('[data-slot="sidebar-footer"]')!;
    const usage = screen.container.querySelector<HTMLElement>(
      '[data-testid="sidebar-usage-overlay"]',
    )!;
    const viewport = screen.container.querySelector<HTMLElement>(
      '[data-slot="sidebar"] [data-slot="scroll-area-viewport"]',
    )!;
    const lastTitle = screen.getByText(`Thread ${THREAD_COUNT} snoozed`).element() as HTMLElement;
    const lastRow = lastTitle.closest("li") ?? lastTitle;

    // Many rows: the list overflows, and the last row starts out of view.
    expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
    expect(lastRow.getBoundingClientRect().top).toBeGreaterThan(footer.getBoundingClientRect().top);

    viewport.scrollTop = viewport.scrollHeight;
    await expect
      .poll(() => Math.ceil(viewport.scrollTop + viewport.clientHeight))
      .toBeGreaterThanOrEqual(viewport.scrollHeight);

    const row = lastRow.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    const scrollAreaBottom = viewport.getBoundingClientRect().bottom;
    expect(row.height).toBeGreaterThan(0);
    expect(row.bottom).toBeLessThanOrEqual(footerRect.top);
    expect(row.bottom).toBeLessThanOrEqual(scrollAreaBottom);
    expect(usage.getBoundingClientRect().top).toBeGreaterThanOrEqual(scrollAreaBottom);
    expect(footerRect.bottom).toBeLessThanOrEqual(height);
    // Nothing sits on top of the row.
    const hit = document.elementFromPoint(row.left + row.width / 2, row.top + row.height / 2);
    expect(hit !== null && lastRow.contains(hit)).toBe(true);

    if (PROOF_DIR) {
      await page.screenshot({
        path: `${PROOF_DIR}/1.2-sidebar-usage-${name}-${width}x${height}.png`,
      });
    }
  },
);
