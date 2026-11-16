import { createElement, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import "../../index.css";
import { SidebarChromeHeader } from "./SidebarChrome";
import { SidebarProvider } from "../ui/sidebar";

const state = vi.hoisted(() => ({ mode: "artwork", stage: "Nightly" }));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => [],
}));
vi.mock("../../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useSettings")>()),
  useEnvironmentIdentificationMode: () => state.mode,
}));
vi.mock("../SidebarStageBackdrop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../SidebarStageBackdrop")>()),
  useEnvironmentStageLabel: () => state.stage,
}));
vi.mock("../../navigationHistory", () => ({
  navigateHistory: () => {},
  useCanNavigateHistory: () => true,
}));
vi.mock("../../state/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/server")>()),
  primaryServerKeybindingsAtom: "keys",
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) =>
    createElement("a", { ...props, href: to }, children),
}));

async function renderHeader(mode: string, isElectron: boolean) {
  await page.viewport(1280, 300);
  state.mode = mode;
  return render(
    <SidebarProvider>
      <SidebarChromeHeader isElectron={isElectron} />
    </SidebarProvider>,
  );
}

const artwork = (screen: Awaited<ReturnType<typeof renderHeader>>) =>
  screen.container.querySelector("[data-stage-art]")?.getAttribute("data-stage-art") ?? null;

it.each([
  ["artwork", true, "nightly", "text-white"],
  ["artwork", false, null, "text-foreground"],
  ["nightly-artwork", false, null, "text-foreground"],
  ["pill", false, null, "text-foreground"],
])("Nightly %s in Electron=%s shows %s artwork", async (mode, isElectron, art, brandClass) => {
  state.stage = "Nightly";
  await using screen = await renderHeader(mode, isElectron);
  expect(artwork(screen)).toBe(art);
  expect(screen.container.querySelector("a")?.classList.contains(brandClass)).toBe(true);
  expect(screen.container.querySelector("[data-environment-identification]") !== null).toBe(
    mode === "pill",
  );
});

it("keeps Dev artwork outside Electron", async () => {
  state.stage = "Dev";
  await using screen = await renderHeader("artwork", false);
  expect(artwork(screen)).toBe("blueprint");
  expect(screen.container.querySelector("a")?.classList.contains("text-white")).toBe(true);
});
