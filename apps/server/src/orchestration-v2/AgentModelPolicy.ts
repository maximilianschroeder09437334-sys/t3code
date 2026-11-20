import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import { createModelSelection, modelSelectionsEqual } from "@t3tools/shared/model";

type Selection = {
  readonly instanceId?: string | undefined;
  readonly model?: string | undefined;
  readonly options?:
    | ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>
    | undefined;
};

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

export function agentModelPolicy(input: {
  readonly selection: Selection | undefined;
  readonly provider?: Pick<ServerProvider, "instanceId" | "models"> | undefined;
}): string | null {
  const selection = input.selection;
  if (!selection?.instanceId?.trim() || !selection.model?.trim())
    return "Agent-created work requires an explicit provider and model.";
  if (!input.provider || input.provider.instanceId !== selection.instanceId)
    return "The selected provider is unavailable or unverified.";
  const models = input.provider.models.filter(
    (candidate) =>
      candidate.slug.toLowerCase() === selection.model!.toLowerCase() ||
      candidate.aliases?.some((alias) => alias.toLowerCase() === selection.model!.toLowerCase()),
  );
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
  const effort = descriptors.find(
    (descriptor) =>
      descriptor.type === "select" &&
      (descriptor.role === "reasoning" ||
        ["reasoningEffort", "effort", "thought_level"].includes(descriptor.id)),
  );
  if (!effort || !options.some((option) => option.id === effort.id))
    return "Agent-created work requires an explicit advertised reasoning effort.";
  return null;
}
