import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveHookSetupConfiguration } from "./hookSetup";

const project = { id: ProjectId.make("project-a") };
const codex = ProviderInstanceId.make("codex");
const other = ProviderInstanceId.make("other");
const provider = (id: ProviderInstanceId, enabled = true): ServerProvider => ({
  instanceId: id,
  driver: ProviderDriverKind.make("codex"),
  enabled,
  installed: true,
  status: "ready",
  version: null,
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00Z",
  models: [{ slug: "gpt-test", name: "Test", isCustom: false, capabilities: {} }],
  slashCommands: [],
  skills: [],
});

describe("hook setup provider and mode", () => {
  it("keeps the selected model and the project's default permission mode", () => {
    const selection = { instanceId: codex, model: "gpt-selected" };
    const result = resolveHookSetupConfiguration({
      project,
      settings: { ...DEFAULT_SERVER_SETTINGS, defaultRuntimeMode: "auto" },
      providers: [provider(codex)],
      stickyProvider: codex,
      stickySelection: selection,
    });
    expect(result).toEqual({ modelSelection: selection, runtimeMode: "auto" });
  });

  it("keeps an explicitly selected project draft model over stale sticky choices", () => {
    const selected = {
      instanceId: codex,
      model: "gpt-draft",
      options: [{ id: "reasoningEffort", value: "medium" }],
    };
    const result = resolveHookSetupConfiguration({
      project,
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        defaultModelSelection: { instanceId: codex, model: "gpt-project" },
      },
      providers: [provider(codex)],
      stickyProvider: codex,
      stickySelection: { instanceId: codex, model: "gpt-stale" },
      draftSelection: selected,
    });
    expect(result.modelSelection).toEqual(selected);
  });

  it("uses the configured project default before a stale sticky model", () => {
    const selected = { instanceId: codex, model: "gpt-project" };
    const result = resolveHookSetupConfiguration({
      project,
      settings: { ...DEFAULT_SERVER_SETTINGS, defaultModelSelection: selected },
      providers: [provider(codex)],
      stickyProvider: codex,
      stickySelection: { instanceId: codex, model: "gpt-stale" },
    });
    expect(result.modelSelection).toEqual(selected);
  });
  it("uses the configured fallback for an exhausted default, but keeps an explicit draft", () => {
    const selected = { instanceId: codex, model: "gpt-project" };
    const fallback = { instanceId: other, model: "gpt-fallback" };
    const limited = {
      ...provider(codex),
      usageLimits: {
        checkedAt: "2026-11-01T00:00:00Z",
        windows: [
          {
            id: "five_hour",
            kind: "session" as const,
            label: "Session",
            usedPercent: 100,
            windowDurationMins: 300,
            resetsAt: "2099-01-01T00:00:00Z",
          },
        ],
      },
    };
    const input = {
      project,
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        defaultModelSelection: selected,
        fallbackModelSelection: fallback,
        providerInstances: {
          ...DEFAULT_SERVER_SETTINGS.providerInstances,
          [other]: { driver: ProviderDriverKind.make("codex"), enabled: true, config: {} },
        },
      },
      providers: [limited, provider(other)],
      stickyProvider: codex,
      stickySelection: selected,
    };
    expect(resolveHookSetupConfiguration(input).modelSelection).toEqual(fallback);
    expect(
      resolveHookSetupConfiguration({ ...input, draftSelection: selected }).modelSelection,
    ).toEqual(selected);
  });
  it("does not silently switch to another provider when the selected one is unavailable", () => {
    expect(() =>
      resolveHookSetupConfiguration({
        project,
        settings: DEFAULT_SERVER_SETTINGS,
        providers: [provider(codex, false), provider(other)],
        stickyProvider: codex,
        stickySelection: { instanceId: codex, model: "gpt-selected" },
      }),
    ).toThrow("selected provider is unavailable");
  });

  it("does not use a provider disabled for this project", () => {
    expect(() =>
      resolveHookSetupConfiguration({
        project,
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          projectSettingsOverrides: {
            [project.id]: { providerInstances: { [codex]: { enabled: false } } },
          },
        },
        providers: [provider(codex)],
        stickyProvider: codex,
        stickySelection: { instanceId: codex, model: "gpt-selected" },
      }),
    ).toThrow("selected provider is unavailable");
  });

  it("uses the selected provider's default model when no sticky model was saved", () => {
    const result = resolveHookSetupConfiguration({
      project,
      settings: DEFAULT_SERVER_SETTINGS,
      providers: [provider(codex), provider(other)],
      stickyProvider: codex,
      stickySelection: undefined,
    });
    expect(result.modelSelection).toEqual({ instanceId: codex, model: "gpt-test" });
  });
});
