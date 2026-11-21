import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import {
  resolveProjectProviderInstanceEnabled,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  resolveProjectSettings,
  type LegacyProjectSettingsFields,
} from "@t3tools/shared/projectSettings";
import {
  getDefaultProviderInstanceModel,
  resolveDefaultProviderModelSelection,
  resolveProjectDefaultProviderModelSelection,
} from "~/providerInstances";

/** Match the user's selected provider and the project's own default permissions. */
export function resolveHookSetupConfiguration(input: {
  readonly project: LegacyProjectSettingsFields & { readonly id: ProjectId };
  readonly settings: ServerSettings;
  readonly providers: readonly ServerProvider[];
  readonly stickyProvider: ProviderInstanceId | null;
  readonly stickySelection: ModelSelection | undefined;
  readonly draftSelection?: ModelSelection | null;
}) {
  const { project, settings, providers, stickyProvider, stickySelection, draftSelection } = input;
  const projectSettings = resolveProjectSettings(settings, project.id, project).settings;
  const stickyDefault =
    stickyProvider && !stickySelection
      ? getDefaultProviderInstanceModel(providers, stickyProvider)
      : undefined;
  const requested =
    draftSelection ??
    projectSettings.defaultModelSelection ??
    stickySelection ??
    (stickyProvider && stickyDefault
      ? { instanceId: stickyProvider, model: stickyDefault }
      : null) ??
    resolveProjectDefaultProviderModelSelection(providers, settings, project.id);
  if (!requested)
    throw new Error(
      "No provider model is available for this project. Check Providers and try again.",
    );
  const usageSelection = resolveNewThreadModelSelection({
    defaultSelection: requested,
    explicitSelection: draftSelection ?? null,
    fallbackSelection: settings.fallbackModelSelection,
    providers,
    settings,
    projectId: project.id,
    now: Date.now(),
  }).selection;
  const modelSelection = resolveDefaultProviderModelSelection(providers, usageSelection);
  if (
    !usageSelection ||
    !modelSelection ||
    usageSelection.instanceId !== modelSelection.instanceId ||
    !resolveProjectProviderInstanceEnabled(settings, project.id, usageSelection.instanceId)
  ) {
    throw new Error(
      "The selected provider is unavailable for this project. Check Providers and try again.",
    );
  }
  return { modelSelection, runtimeMode: projectSettings.defaultRuntimeMode };
}
