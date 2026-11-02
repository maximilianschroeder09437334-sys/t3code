import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import * as Option from "effect/Option";

const harness = vi.hoisted(() => ({
  tabs: [] as Array<{ tabId: string; updatedAt: string; navStatus: { _tag: "Idle" } }>,
  error: null as string | null,
  refresh: vi.fn(),
  close: vi.fn(),
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TextInput: () => null,
  Platform: { OS: "android" },
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: harness.close }),
  useIsFocused: () => true,
}));
vi.mock("@react-navigation/native-stack", () => ({
  createNativeStackNavigator: () => ({
    Navigator: ({ children }: { children: ReactNode }) => <>{children}</>,
    Screen: ({ children }: { children: () => ReactNode }) => children(),
  }),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../components/ui/SheetHeader", () => ({ SheetHeader: () => null }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({
  AppActivityIndicator: () => <span>Loading</span>,
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../components/ui/ControlPill", () => ({ ControlPill: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("../../components/ui/AppBar", () => ({
  AppBar: ({
    menus,
  }: {
    menus: Array<{ items: Array<{ id: string; title: string; onPress: () => void }> }>;
  }) => (
    <>
      {menus.flatMap((menu) =>
        menu.items.map((item) => (
          <button key={item.id} onClick={item.onPress}>
            {item.title}
          </button>
        )),
      )}
    </>
  ),
}));
vi.mock("../../lib/appState", () => ({ useAppForeground: () => true }));
vi.mock("../../state/preview", () => ({
  useThreadServerBrowserTabs: () => ({
    tabs: harness.tabs,
    loaded: true,
    error: harness.error,
    refresh: harness.refresh,
  }),
}));
vi.mock("../../state/session", () => ({ usePreparedConnection: () => Option.none() }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeVariables: {} }),
}));
vi.mock("./BrowserTabMenu", () => ({ BrowserTabMenu: () => null }));
vi.mock("./PreviewStreamWebView", () => ({
  PreviewStreamWebView: ({ tabId }: { tabId: string }) => <span>stream:{tabId}</span>,
}));

import { BrowserPreviewRouteScreen } from "./BrowserPreviewRouteScreen";

it("waits for the requested new tab, retries a failed list, and falls back only after the tab closes", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.tabs = [{ tabId: "old", updatedAt: "2026-01-01", navStatus: { _tag: "Idle" } }];
  harness.error = "Connection lost";
  harness.refresh.mockClear();
  harness.close.mockClear();
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = () =>
    root.render(
      <BrowserPreviewRouteScreen
        route={
          {
            key: "browser",
            name: "Browser",
            params: { environmentId: "env", threadId: "thread", tabId: "new" },
          } as never
        }
      />,
    );
  try {
    await act(async () => render());
    expect(container.textContent).not.toContain("stream:old");
    expect(container.textContent).toContain("Connection lost");
    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    );
    expect(retry).toBeDefined();
    await act(async () => retry!.click());
    expect(harness.refresh).toHaveBeenCalledOnce();
    harness.error = null;
    harness.tabs = [
      ...harness.tabs,
      { tabId: "new", updatedAt: "2026-01-02", navStatus: { _tag: "Idle" } },
    ];
    await act(async () => render());
    expect(container.textContent).toContain("stream:new");
    harness.tabs = [harness.tabs[0]!];
    await act(async () => render());
    expect(container.textContent).toContain("stream:old");
    expect(harness.close).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});

it("allows switching away from a missing requested tab and closes when the last seen tab closes", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.tabs = [{ tabId: "old", updatedAt: "2026-01-01", navStatus: { _tag: "Idle" } }];
  harness.error = null;
  harness.close.mockClear();
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = () =>
    root.render(
      <BrowserPreviewRouteScreen
        route={
          {
            key: "browser",
            name: "Browser",
            params: { environmentId: "env", threadId: "thread", tabId: "new" },
          } as never
        }
      />,
    );
  try {
    await act(async () => render());
    expect(container.textContent).not.toContain("stream:old");
    const old = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "New tab",
    );
    expect(old).toBeDefined();
    await act(async () => old!.click());
    expect(container.textContent).toContain("stream:old");
    harness.tabs = [];
    await act(async () => render());
    expect(harness.close).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
  }
});
