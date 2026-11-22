import type {
  AgentExecutionIntent,
  ModelSelection,
  ProviderOptionDescriptor,
  SelectProviderOptionDescriptor,
  ServerProvider,
} from "@t3tools/contracts";
import { createModelSelection, modelSelectionsEqual } from "@t3tools/shared/model";

type Selection = {
  readonly instanceId?: string | undefined;
  readonly model?: string | undefined;
  readonly options?:
    | ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>
    | undefined;
};

type Provider = Pick<ServerProvider, "instanceId" | "models">;

/**
 * Whether a run carries the selection an agent chose. A switched-off option (such as the
 * `fastMode: false` a composer adds) reads the same as one left unset.
 */
export function agentSelectionMatchesRun(intent: ModelSelection, run: ModelSelection): boolean {
  const withoutOffOptions = (selection: ModelSelection) =>
    createModelSelection(
      selection.instanceId,
      selection.model,
      selection.options?.filter((option) => option.value !== false),
    );
  return modelSelectionsEqual(withoutOffOptions(intent), withoutOffOptions(run));
}

/** Whether the intent's selection is the pick a person made, not one an agent set since. */
export function intentRunsUserPick(intent: AgentExecutionIntent): boolean {
  return (
    intent.userModelSelection !== undefined &&
    agentSelectionMatchesRun(intent.userModelSelection, intent.modelSelection)
  );
}

function advertisedModels(selection: Selection, provider: Provider) {
  const model = selection.model!.toLowerCase();
  return provider.models.filter(
    (candidate) =>
      candidate.slug.toLowerCase() === model ||
      candidate.aliases?.some((alias) => alias.toLowerCase() === model),
  );
}

function reasoningEffortDescriptor(descriptors: ReadonlyArray<ProviderOptionDescriptor>) {
  return descriptors.find(
    (descriptor): descriptor is SelectProviderOptionDescriptor =>
      descriptor.type === "select" &&
      (descriptor.role === "reasoning" ||
        ["reasoningEffort", "effort", "thought_level"].includes(descriptor.id)),
  );
}

/**
 * The selection a person's pick runs on. Composers send only the options a person set, so a
 * pick that leaves effort at the model's advertised default carries no effort; this states that
 * default. Anything else, including a model without an advertised default, stays as it is.
 */
export function withAdvertisedDefaultEffort(
  selection: ModelSelection,
  provider: Provider | undefined,
): ModelSelection {
  if (!provider || provider.instanceId !== selection.instanceId) return selection;
  const models = advertisedModels(selection, provider);
  const descriptors = models.length === 1 ? models[0]!.capabilities?.optionDescriptors : undefined;
  const effort = descriptors ? reasoningEffortDescriptor(descriptors) : undefined;
  if (!effort || selection.options?.some((option) => option.id === effort.id)) return selection;
  const value = effort.currentValue ?? effort.options.find((choice) => choice.isDefault)?.id;
  if (value === undefined) return selection;
  return createModelSelection(selection.instanceId, selection.model, [
    ...(selection.options ?? []),
    { id: effort.id, value },
  ]);
}

export function agentModelPolicy(input: {
  readonly selection: Selection | undefined;
  readonly provider?: Provider | undefined;
}): string | null {
  const selection = input.selection;
  if (!selection?.instanceId?.trim() || !selection.model?.trim())
    return "Agent-created work requires an explicit provider and model.";
  if (!input.provider || input.provider.instanceId !== selection.instanceId)
    return "The selected provider is unavailable or unverified.";
  const models = advertisedModels(selection, input.provider);
  if (models.length !== 1) return "The selected model is unadvertised or ambiguous.";
  const model = models[0]!;
  const descriptors = model.capabilities?.optionDescriptors;
  if (!descriptors) return "The provider did not advertise model options.";
  const options = selection.options ?? [];
  const seen = new Set<string>();
  for (const option of options) {
    if (seen.has(option.id)) return "Duplicate model option.";
    seen.add(option.id);
    const descriptor = descriptors.find((candidate) => candidate.id === option.id);
    if (
      !descriptor ||
      (descriptor.type === "boolean"
        ? typeof option.value !== "boolean"
        : !descriptor.options.some((choice) => choice.id === option.value))
    )
      return "An option is not advertised for the selected model.";
  }
  const effort = reasoningEffortDescriptor(descriptors);
  if (!effort || !options.some((option) => option.id === effort.id))
    return "Agent-created work requires an explicit advertised reasoning effort.";
  return null;
}
