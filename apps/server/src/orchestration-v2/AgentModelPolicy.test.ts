import { assert, it } from "@effect/vitest";
import type { ServerProvider } from "@t3tools/contracts";
import { agentModelPolicy } from "./AgentModelPolicy.ts";

const provider = {
  instanceId: "claudeAgent",
  models: [
    {
      slug: "claude-opus-5-5",
      name: "Opus",
      aliases: ["research-model"],
      capabilities: {
        optionDescriptors: [
          { id: "effort", role: "reasoning", type: "select", options: [{ id: "medium" }] },
        ],
      },
    },
  ],
} as unknown as ServerProvider;
const selection = {
  instanceId: "claudeAgent",
  model: "research-model",
  options: [{ id: "effort", value: "medium" }],
};

it("requires explicit supported provider, model and effort and a bounded purpose for Opus planning", () => {
  const base = { selection, interactionMode: "plan", explicitPlan: true, provider } as const;
  assert.isNotNull(agentModelPolicy({ ...base, selection: undefined }));
  assert.isNotNull(agentModelPolicy({ ...base, selection: { ...selection, options: undefined } }));
  assert.isNotNull(agentModelPolicy(base));
  assert.isNull(agentModelPolicy({ ...base, planningPurpose: "Design the bounded retry policy" }));
  assert.isNotNull(
    agentModelPolicy({
      ...base,
      planningPurpose: "Design the bounded retry policy",
      selection: { ...selection, options: [{ id: "effort", value: "invalid" }] },
    }),
  );
  assert.isNotNull(
    agentModelPolicy({ ...base, interactionMode: "default", planningPurpose: "Design" }),
  );
  assert.isNotNull(agentModelPolicy({ ...base, provider: undefined, planningPurpose: "Design" }));
});

it("rejects ambiguous model aliases rather than selecting a potentially unsafe model", () => {
  const collision = {
    ...provider,
    models: [
      ...provider.models,
      { ...provider.models[0]!, slug: "gpt-safe", name: "GPT", aliases: ["research-model"] },
    ],
  };
  assert.isNotNull(
    agentModelPolicy({
      selection,
      provider: collision,
      interactionMode: "plan",
      explicitPlan: true,
      planningPurpose: "Design the retry policy",
    }),
  );
});
