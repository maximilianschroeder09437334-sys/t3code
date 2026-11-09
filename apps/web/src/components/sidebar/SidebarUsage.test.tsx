import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { SidebarUsage } from "./SidebarUsage";

const state = vi.hoisted(() => ({ presentations: new Map<string, unknown>() }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.presentations }));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationsWithProvidersAtom: {} },
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { refreshProviders: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => () => Promise.resolve() }));
vi.mock("../../hooks/useNowMinute", () => ({ useNowMinute: () => "2026-09-03T12:00" }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) =>
    createElement("a", { href: to }, children),
}));

const checkedAt = "2026-09-03T11:59:00.000Z";
const weekly = {
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 25,
  windowDurationMins: 10080,
  resetsAt: "2026-09-06T12:00:00.000Z",
};
const session = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
};
function setWindows(windows: unknown[], connection = "connected") {
  state.presentations = new Map([
    [
      "test-env",
      {
        entry: { target: { label: "Test only" } },
        connection: { phase: connection },
        serverConfig: {
          providers: [
            {
              instanceId: "codex",
              driver: "codex",
              enabled: true,
              installed: true,
              status: "ready",
              auth: { status: "authenticated" },
              checkedAt,
              models: [],
              slashCommands: [],
              skills: [],
              usageLimits: { checkedAt, windows },
            },
          ],
        },
      },
    ],
  ]);
}

describe("offline sidebar usage fixture", () => {
  it("shows the weekly window and links to usage", () => {
    setWindows([weekly]);
    const html = renderToStaticMarkup(createElement(SidebarUsage));
    expect(html).toContain("Codex Weekly");
    expect(html).toContain("75%");
    expect(html).toContain('href="/usage"');
    expect(html).not.toContain("Session");
  });
  it("shows both reported windows and marks disconnected data stale", () => {
    setWindows([weekly, session], "disconnected");
    const html = renderToStaticMarkup(createElement(SidebarUsage));
    expect(html).toContain("Codex Weekly");
    expect(html).toContain("Codex Session");
    expect(html).toContain("75% stale");
    expect(html).toContain("60% stale");
  });
  it("shows no floating surface when no usage windows are reported", () => {
    setWindows([]);
    expect(renderToStaticMarkup(createElement(SidebarUsage))).toBe("");
  });
});
