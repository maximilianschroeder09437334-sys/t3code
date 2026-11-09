import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const { Children, mocks } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    refresh: vi.fn(),
    listeners: [] as Array<(state: string) => void>,
    hooks: [] as Array<Record<string, unknown>>,
    alert: vi.fn(),
    approve: vi.fn(async () => ({ _tag: "Success" })),
    approveTag: { permissionAtom: () => true },
    remove: vi.fn(async () => ({ _tag: "Success" })),
    removeTag: { permissionAtom: () => true },
    otherTag: { permissionAtom: () => true },
    canWrite: true,
    connected: true,
    environmentExists: true,
  },
}));

vi.mock("react-native", () => ({
  View: Children,
  ScrollView: Children,
  TextInput: ({ value }: { value: string }) => <pre>{value}</pre>,
  Switch: () => null,
  Alert: { alert: mocks.alert },
  AppState: {
    addEventListener: (_event: string, callback: (state: string) => void) => {
      mocks.listeners.push(callback);
      return {
        remove: () => {
          mocks.listeners = mocks.listeners.filter((item) => item !== callback);
        },
      };
    },
  },
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
    disabled,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
    disabled?: boolean;
  }) => (
    <button onClick={onPress} aria-label={accessibilityLabel} disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    accessibilityLabel,
    onPress,
    disabled,
  }: {
    label: string;
    accessibilityLabel?: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button aria-label={accessibilityLabel ?? label} onClick={onPress} disabled={disabled}>
      {label}
    </button>
  ),
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: mocks.hooks,
    error: null,
    isPending: false,
    refresh: mocks.refresh,
  }),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: mocks.environmentExists ? [{ environmentId: "pc" }] : [],
  }),
}));
vi.mock("../../state/hooks", () => ({
  hooksList: () => ({}),
  hookApprove: mocks.approveTag,
  hookSetEnabled: mocks.otherTag,
  hookUpdateDraft: mocks.otherTag,
  hookDelete: mocks.removeTag,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === mocks.approveTag
      ? mocks.approve
      : command === mocks.removeTag
        ? mocks.remove
        : vi.fn(),
}));
vi.mock("../../state/entities", () => ({
  useServerConfigs: () =>
    new Map([["pc", { environment: { capabilities: { hookRemoval: true } } }]]),
}));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => mocks.canWrite,
  useEnvironmentScope: () => true,
}));
vi.mock("./components/SettingsEnvironmentFilterHeader", () => ({
  useSettingsEnvironmentMenu: () => ({ title: "Settings scope", items: [] }),
  SettingsEnvironmentFilterHeader: () => null,
}));
vi.mock("./components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("./components/SettingsSection", () => ({ SettingsSection: Children }));
vi.mock("./settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({
    availableTargets: mocks.environmentExists
      ? [
          {
            environmentId: "pc",
            label: "PC",
            connection: { phase: mocks.connected ? "connected" : "offline" },
          },
        ]
      : [],
    selectedTargets: mocks.environmentExists
      ? [
          {
            environmentId: "pc",
            label: "PC",
            connection: { phase: mocks.connected ? "connected" : "offline" },
          },
        ]
      : [],
    selectedIds: null,
    projectGroups: [
      {
        key: "p",
        label: "Project",
        members: [
          { project: { id: "p", title: "Project", environmentId: "pc", archivedAt: null } },
        ],
      },
    ],
    selectedProjectKey: null,
  }),
}));

import { SettingsHooksRouteScreen } from "./SettingsHooksRouteScreen";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  mocks.refresh.mockReset();
  mocks.listeners = [];
  mocks.hooks = [];
  mocks.alert.mockReset();
  mocks.approve.mockClear();
  mocks.remove.mockClear();
  mocks.canWrite = true;
  mocks.connected = true;
  mocks.environmentExists = true;
});

it("keeps the last hooks read-only across a brief disconnection and blocks a pending approval", () => {
  mocks.hooks = [
    {
      id: "draft",
      projectId: "p",
      name: "Cached draft",
      event: "before_browser_action",
      scope: "all-projects",
      script: 'return { decision: "allow" };',
      scriptSha256: "a".repeat(64),
      status: "draft",
      enabled: false,
      createdAt: 1,
    },
  ];
  act(() => root.render(<SettingsHooksRouteScreen />));
  act(() =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Show script for Cached draft"]')!
      .click(),
  );
  const review = container.querySelector<HTMLButtonElement>(
    '[aria-label="Review and approve Cached draft"]',
  );
  expect(review).not.toBeNull();
  act(() => review!.click());
  const choices = (
    mocks.alert.mock.calls[0] as unknown as [
      string,
      string,
      Array<{ text: string; onPress?: () => void }>,
    ]
  )[2];
  mocks.connected = false;
  mocks.hooks = [];
  act(() => root.render(<SettingsHooksRouteScreen />));
  expect(container.textContent).toContain("Showing last known hooks");
  expect(container.textContent).toContain("Cached draft");
  expect(container.querySelector('[aria-label="Review and approve Cached draft"]')).toBeNull();
  act(() => choices.find((choice) => choice.text === "Approve")?.onPress?.());
  expect(mocks.approve).not.toHaveBeenCalled();
  mocks.environmentExists = false;
  act(() => root.render(<SettingsHooksRouteScreen />));
  expect(container.textContent).not.toContain("Cached draft");
  mocks.environmentExists = true;
  mocks.connected = true;
  act(() => root.render(<SettingsHooksRouteScreen />));
  expect(container.textContent).not.toContain("Showing last known hooks");
});

it("shows a persisted hook read-only when the screen first opens offline", () => {
  mocks.connected = false;
  mocks.hooks = [
    {
      id: "cached",
      projectId: "p",
      name: "Saved hook",
      event: "before_browser_action",
      scope: "all-projects",
      script: 'return { decision: "allow" };',
      scriptSha256: "a".repeat(64),
      status: "active",
      enabled: true,
      createdAt: 1,
    },
  ];
  act(() => root.render(<SettingsHooksRouteScreen />));
  expect(container.textContent).toContain("Showing last known hooks");
  expect(container.textContent).toContain("Saved hook");
  expect(container.querySelector('[aria-label="Refresh hooks for All projects"]')).toBeNull();
});

it("shows draft review and sends the reviewed event, scope and hash only after confirmation", async () => {
  const hash = "a".repeat(64);
  const script = 'return { decision: "allow" };';
  mocks.hooks = [
    {
      id: "browser-recovery",
      projectId: "p",
      name: "Require browser recovery after failure",
      event: "before_browser_action",
      scope: "all-projects",
      script,
      scriptSha256: hash,
      status: "draft",
      enabled: false,
      createdAt: 1,
    },
  ];
  act(() => root.render(<SettingsHooksRouteScreen />));
  expect(container.textContent).not.toContain(script);
  expect(
    container.querySelector(
      '[aria-label="Review and approve Require browser recovery after failure"]',
    ),
  ).toBeNull();
  act(() =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Show script for Require browser recovery after failure"]',
      )!
      .click(),
  );
  expect(container.textContent).toContain(script);
  const button = container.querySelector<HTMLButtonElement>(
    '[aria-label="Review and approve Require browser recovery after failure"]',
  );
  expect(button).not.toBeNull();
  act(() => button!.click());
  expect(mocks.approve).not.toHaveBeenCalled();
  const [title, message, choices] = mocks.alert.mock.calls[0] as unknown as [
    string,
    string,
    Array<{ text: string; onPress?: () => void }>,
  ];
  expect(title).toBe("Approve this exact script?");
  expect(message).toContain(hash);
  expect(message).toContain("Before T3 browser mutation");
  expect(message).toContain("all projects in this environment");
  const confirm = choices.find((choice) => choice.text === "Approve")?.onPress;
  expect(confirm).toBeDefined();
  mocks.canWrite = false;
  act(() => confirm!());
  expect(mocks.approve).not.toHaveBeenCalled();
  mocks.canWrite = true;
  await act(async () => confirm!());
  expect(mocks.approve).toHaveBeenCalledWith({
    environmentId: "pc",
    input: {
      projectId: "p",
      hookId: "browser-recovery",
      reviewedSha256: hash,
      reviewedEvent: "before_browser_action",
      reviewedScope: "all-projects",
    },
  });
});
afterEach(() => act(() => root.unmount()));

it("refreshes hook state on foreground and when the user asks", () => {
  act(() => root.render(<SettingsHooksRouteScreen />));
  expect(mocks.listeners.length).toBeGreaterThan(0);
  act(() => mocks.listeners.forEach((listener) => listener("background")));
  expect(mocks.refresh).not.toHaveBeenCalled();
  act(() => mocks.listeners.forEach((listener) => listener("active")));
  expect(mocks.refresh).toHaveBeenCalled();
  mocks.refresh.mockClear();
  const button = container.querySelector<HTMLButtonElement>(
    '[aria-label="Refresh hooks for All projects"]',
  );
  expect(button).not.toBeNull();
  act(() => button!.click());
  expect(mocks.refresh).toHaveBeenCalledOnce();
});

it("hides removal for enabled hooks and rechecks access after confirmation", () => {
  const base = {
    id: "retired",
    projectId: "p",
    name: "Retired guard",
    event: "turn_end",
    scope: "all-projects",
    script: 'return { decision: "allow" };',
    scriptSha256: "b".repeat(64),
    status: "active",
    enabled: true,
    createdAt: 1,
  };
  mocks.hooks = [base];
  act(() => root.render(<SettingsHooksRouteScreen />));
  expect(container.querySelector('[aria-label="Remove Retired guard"]')).toBeNull();
  mocks.hooks = [{ ...base, enabled: false }];
  act(() => root.render(<SettingsHooksRouteScreen />));
  const button = container.querySelector<HTMLButtonElement>('[aria-label="Remove Retired guard"]');
  expect(button).not.toBeNull();
  act(() => button!.click());
  const choices = (
    mocks.alert.mock.calls[0] as unknown as [
      string,
      string,
      Array<{ text: string; onPress?: () => void }>,
    ]
  )[2];
  mocks.canWrite = false;
  act(() => choices.find((choice) => choice.text === "Remove")?.onPress?.());
  expect(mocks.remove).not.toHaveBeenCalled();
});
