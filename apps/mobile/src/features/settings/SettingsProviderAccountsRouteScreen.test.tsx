import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const { Children, data } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  data: {
    providers: new Map([
      [
        "pc",
        [
          {
            instanceId: "codex",
            displayName: "Codex",
            driver: "codex",
            auth: { status: "authenticated" },
          },
        ],
      ],
    ]),
  },
}));
vi.mock("react-native", () => ({
  View: Children,
  ScrollView: Children,
  TextInput: Children,
  Pressable: Children,
  Linking: {},
  useWindowDimensions: () => ({ fontScale: 1 }),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => data.providers }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: Children }));
vi.mock("../../components/ui/ControlPill", () => ({ ControlPill: Children }));
vi.mock("../../components/ui/Menu", () => ({ Menu: Children }));
vi.mock("../../components/ui/ListActionRow", () => ({ ListActionRow: Children }));
vi.mock("../../components/ui/Dialog", () => ({}));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { providersByEnvironmentAtom: {} },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => {
    throw new Error("Offline view must not start provider auth queries");
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => {
    throw new Error("Offline view must not create provider actions");
  },
}));
vi.mock("../../state/session", () => ({ useEnvironmentsWithScope: () => new Set(["pc"]) }));
vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("./components/SettingsEnvironmentFilterHeader", () => ({
  useSettingsEnvironmentMenu: () => ({ title: "Settings scope", items: [] }),
  SettingsEnvironmentFilterHeader: () => null,
}));
vi.mock("./components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("./components/SettingsSection", () => ({ SettingsSection: Children }));
vi.mock("./settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({
    selectedTargets: [{ environmentId: "pc", label: "PC", connection: { phase: "offline" } }],
  }),
}));

import { SettingsProviderAccountsRouteScreen } from "./SettingsProviderAccountsRouteScreen";

it("shows cached provider status without creating sign-in actions while offline", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<SettingsProviderAccountsRouteScreen />));
  expect(container.textContent).toContain("Disconnected");
  expect(container.textContent).toContain("Codex");
  expect(container.textContent).toContain("Last known: signed in");
  act(() => root.unmount());
});
