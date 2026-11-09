import { createElement, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import "../../index.css";
import { SidebarChromeFooter } from "./SidebarChrome";
import { SidebarProvider } from "../ui/sidebar";

const state = vi.hoisted(() => ({ presentations: new Map<string, unknown>() }));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: (atom: unknown) => (atom === "presentations" ? state.presentations : []),
}));
vi.mock("../../state/presentation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/presentation")>()),
  environmentPresentations: { presentationsWithProvidersAtom: "presentations" },
}));
vi.mock("../../state/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/server")>()),
  serverEnvironment: { refreshProviders: {} },
  primaryServerKeybindingsAtom: "keys",
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => () => Promise.resolve() }));
vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
  usePullRequestsSupported: () => false,
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

it("reserves weekly usage space below scrolling threads without covering the last row", async () => {
  await page.viewport(1000, 700);
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
  await using screen = await render(
    <SidebarProvider>
      <div
        data-testid="fixture-sidebar"
        style={{
          display: "flex",
          flexDirection: "column",
          height: 520,
          width: 280,
          position: "relative",
        }}
      >
        <div data-testid="fixture-threads" style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
          {Array.from({ length: 40 }, (_, index) => (
            <div key={index} style={{ height: 32 }}>
              Thread {index + 1}
            </div>
          ))}
        </div>
        <SidebarChromeFooter />
      </div>
    </SidebarProvider>,
    { router: false },
  );
  await expect.element(screen.getByText("Codex Weekly")).toBeVisible();
  await expect.element(screen.getByText("5d 19h / 76%")).toBeVisible();
  const footer = screen.container.querySelector<HTMLElement>('[data-slot="sidebar-footer"]')!;
  const overlay = screen.container.querySelector<HTMLElement>(
    '[data-testid="sidebar-usage-overlay"]',
  )!;
  const threads = screen.container.querySelector<HTMLElement>('[data-testid="fixture-threads"]')!;
  const before = overlay.getBoundingClientRect();
  expect(before.top).toBeGreaterThanOrEqual(footer.getBoundingClientRect().top);
  expect(before.top).toBeGreaterThanOrEqual(threads.getBoundingClientRect().bottom);
  expect(getComputedStyle(overlay).position).toBe("static");
  expect(overlay.querySelector('a[href="/usage"]')).not.toBeNull();
  threads.scrollTop = threads.scrollHeight;
  await expect.poll(() => threads.scrollTop).toBeGreaterThan(0);
  expect(overlay.getBoundingClientRect().top).toBeCloseTo(before.top, 0);
});
