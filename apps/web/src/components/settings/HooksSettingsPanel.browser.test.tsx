import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import type { ReactNode } from "react";

const state = vi.hoisted(() => ({
  removeTag: {},
  remove: vi.fn(async () => ({ _tag: "Success" })),
  changed: vi.fn(),
  confirm: vi.fn(async () => true),
}));
vi.mock("~/state/hooks", () => ({
  hooksList: () => ({}),
  hookApprove: {},
  hookSetEnabled: {},
  hookUpdateDraft: {},
  hookDelete: state.removeTag,
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (tag: unknown) => (tag === state.removeTag ? state.remove : vi.fn()),
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    isPending: false,
    error: null,
    refresh: vi.fn(),
    data: [
      {
        id: "live",
        name: "Live guard",
        event: "turn_end",
        scope: "all-projects",
        status: "active",
        enabled: true,
        script: 'return { decision: "allow" };',
        scriptSha256: "a".repeat(64),
      },
      {
        id: "retired",
        name: "Retired guard",
        event: "turn_end",
        scope: "all-projects",
        status: "active",
        enabled: false,
        script: 'return { decision: "allow" };',
        scriptSha256: "b".repeat(64),
      },
    ],
  }),
}));
vi.mock("~/state/entities", () => ({
  useServerConfigs: () =>
    new Map([["pc", { environment: { capabilities: { hookRemoval: true } } }]]),
}));
vi.mock("~/state/session", () => ({ readEnvironmentScope: () => true }));
vi.mock("~/state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("~/state/threads", () => ({ threadEnvironment: { startTurn: {} } }));
vi.mock("~/state/use-orchestration-command", () => ({ useOrchestrationCommand: () => vi.fn() }));
vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: { get: () => new Map(), refresh: vi.fn() },
}));
vi.mock("~/composerDraftStore", async () => {
  const Schema = await import("effect/Schema");
  return {
    DraftId: Schema.String.pipe(Schema.brand("DraftId")),
    useComposerDraftStore: { getState: () => ({}) },
  };
});
vi.mock("./SettingsScopeContext", () => ({ useSettingsScope: () => ({}) }));
vi.mock("../ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (value: unknown) => value,
}));
vi.mock("~/confirmDialog", () => ({ requestConfirmDialog: state.confirm }));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));
vi.mock("./HookRuntimeStatus", () => ({ HookRuntimeStatus: () => null }));
vi.mock("./HookBuilder", () => ({ HookBuilder: () => null }));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsSection: ({
    children,
    title,
    headerAction,
  }: {
    children: ReactNode;
    title: string;
    headerAction: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {headerAction}
      {children}
    </section>
  ),
  SettingsRow: ({
    title,
    description,
    control,
  }: {
    title: string;
    description: string;
    control?: ReactNode;
  }) => (
    <div>
      <h3>{title}</h3>
      <p>{description}</p>
      {control}
    </div>
  ),
}));

import { HookProjectPanel } from "./HooksSettingsPanel";

it("keeps global hooks visible below the introduction and removes only a disabled exact version", async () => {
  await using screen = await render(
    <HookProjectPanel
      project={{ id: "p", title: "Project", environmentId: "pc", environmentLabel: "PC" } as never}
      panelScope="all-projects"
      sectionId="hooks-manager"
      showIntro
      onChanged={state.changed}
    />,
    { router: false },
  );
  await expect.element(screen.getByText("Live guard", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Remove Live guard" }))
    .not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Remove Retired guard" }).click();
  expect(state.confirm).toHaveBeenCalledOnce();
  await expect.poll(() => state.remove.mock.calls.length).toBe(1);
  expect(state.remove).toHaveBeenCalledWith({
    environmentId: "pc",
    input: { projectId: "p", hookId: "retired", expectedSha256: "b".repeat(64) },
  });
  expect(state.changed).toHaveBeenCalledOnce();
});
