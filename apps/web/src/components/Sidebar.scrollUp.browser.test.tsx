import appCss from "../index.css?inline";
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { makeThreadFixture } from "../test-fixtures";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { useProjects, useQuietThreadShells, useServerConfigs } from "../state/entities";
import type { Project } from "../types";
import Sidebar from "./Sidebar";
import { SidebarProvider } from "./ui/sidebar";

vi.mock("../state/entities", { spy: true });
vi.mock("../hooks/useHandleNewThread", { spy: true });
vi.mock("../hooks/useThreadRouteTarget", { spy: true });
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));

interface ScrollProbe {
  /** Measurements where rows on screen had moved within the list since the last measurement. */
  readonly jumps: number;
  /** Sum of the largest such move per measurement, in CSS px. */
  readonly jumpPx: number;
}

const rowsOnScreen = (viewport: HTMLElement) => {
  const box = viewport.getBoundingClientRect();
  return [...viewport.querySelectorAll<HTMLElement>("[data-thread-item]")].filter((row) => {
    const rect = row.getBoundingClientRect();
    return rect.bottom > box.top && rect.top < box.bottom;
  });
};

// content-visibility skips a row's contents, not the row, so its child shows whether it rendered.
const waitForRowsOnScreen = (viewport: HTMLElement) =>
  vi.waitFor(() => {
    const rows = rowsOnScreen(viewport);
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.every((row) => row.firstElementChild?.checkVisibility({ contentVisibilityAuto: true })),
    ).toBe(true);
  });

// Scrolls like a finger drag and tracks each row's offset within the list. Only a row above it
// changing height moves a row within the list, and on screen that reads as the list jumping.
async function probeScroll(viewport: HTMLElement, step: number) {
  const offsets = new Map<HTMLElement, number>();
  let jumps = 0;
  let jumpPx = 0;
  const measure = () => {
    const top = viewport.getBoundingClientRect().top - viewport.scrollTop;
    let largest = 0;
    for (const row of rowsOnScreen(viewport)) {
      const offset = row.getBoundingClientRect().top - top;
      const previous = offsets.get(row);
      if (previous !== undefined) largest = Math.max(largest, Math.abs(offset - previous));
      offsets.set(row, offset);
    }
    if (largest > 0.5) {
      jumps++;
      jumpPx += largest;
    }
  };
  measure();
  for (;;) {
    const before = viewport.scrollTop;
    viewport.scrollTop = before + step;
    if (viewport.scrollTop === before) break;
    await waitForRowsOnScreen(viewport);
    measure();
  }
  return { jumps, jumpPx: Math.round(jumpPx) } satisfies ScrollProbe;
}

function project(id: string): Project {
  return {
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make("local"),
    title: id,
    workspaceRoot: `/projects/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  };
}

async function renderLongSidebar(rootFontSize: string | null) {
  const stack = new AsyncDisposableStack();
  const style = document.createElement("style");
  style.textContent = appCss;
  document.head.append(style);
  stack.defer(() => style.remove());
  if (rootFontSize !== null) {
    const previous = document.documentElement.style.fontSize;
    document.documentElement.style.fontSize = rootFontSize;
    stack.defer(() => {
      document.documentElement.style.fontSize = previous;
    });
  }
  const activeProject = project("active");
  // Active threads render as cards, half of them with a branch line, like a busy sidebar.
  const threads = Array.from({ length: 60 }, (_, index) =>
    makeThreadFixture({
      environmentId: activeProject.environmentId,
      projectId: activeProject.id,
      id: ThreadId.make(`active-${index}`),
      title: `Active thread ${index}`,
      branch: index % 2 === 0 ? `feature/branch-${index}` : null,
    }),
  );
  const routeThreadRef = {
    environmentId: activeProject.environmentId,
    threadId: threads.at(-1)!.id,
  };
  vi.mocked(useProjects).mockReturnValue([activeProject]);
  vi.mocked(useQuietThreadShells).mockReturnValue(threads);
  vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef: routeThreadRef });
  vi.mocked(useHandleNewThread).mockReturnValue({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef: { environmentId: activeProject.environmentId, projectId: activeProject.id },
    defaultProjectFallbackReady: true,
    handleNewThread: vi.fn().mockResolvedValue(null),
    routeDraftId: null,
    routeThreadRef,
  });
  vi.mocked(useServerConfigs).mockReturnValue(
    new Map([
      [
        activeProject.environmentId,
        {
          scratchWorkspaceRoot: null,
          shellThreadFamilies: false,
        } as unknown as EnvironmentServerConfig,
      ],
    ]),
  );
  const screen = await render(
    <SidebarProvider style={{ height: 600, minHeight: 600 }}>
      <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
    </SidebarProvider>,
  );
  stack.use(screen);
  await expect.element(screen.getByText("Active thread 59").first()).toBeInTheDocument();
  const viewport = screen.container.querySelector<HTMLElement>(
    '[data-slot="sidebar-content"]',
  )!.parentElement!;
  expect(viewport.dataset.slot).toBe("scroll-area-viewport");
  return Object.assign(stack, { viewport });
}

describe("sidebar scrolling through rows that have not rendered yet", () => {
  // Opening a thread reveals its row, so the rows above it have never rendered. Scrolling up
  // renders them one by one; a row whose real height differs from its placeholder must not move
  // the rows on screen, or a touch scroll stutters every row or two.
  it.each([
    { label: "default text size", rootFontSize: null },
    // A phone or browser whose text size is not the 16px default, such as Android text scaling.
    { label: "root font size 18px", rootFontSize: "18px" },
  ])(
    "scrolling up from the revealed row keeps rows on screen steady ($label)",
    async (scenario) => {
      await using fixture = await renderLongSidebar(scenario.rootFontSize);
      const { viewport } = fixture;
      // The mount reveal scrolls the open (last) thread into view, like opening the sidebar on a phone.
      await vi.waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(0));
      await waitForRowsOnScreen(viewport);
      const up = await probeScroll(viewport, -40);
      expect(viewport.scrollTop).toBe(0);

      const down = await probeScroll(viewport, 40);
      expect(down).toEqual({ jumps: 0, jumpPx: 0 });
      expect(up).toEqual({ jumps: 0, jumpPx: 0 });
    },
  );
});
