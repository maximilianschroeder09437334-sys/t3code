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

it("requires an explicit supported provider, model and effort, and allows any advertised model", () => {
  const base = { selection, provider } as const;
  assert.isNotNull(agentModelPolicy({ ...base, selection: undefined }));
  assert.isNotNull(agentModelPolicy({ ...base, selection: { ...selection, options: undefined } }));
  assert.isNull(agentModelPolicy(base));
  assert.isNotNull(
    agentModelPolicy({
      ...base,
      selection: { ...selection, options: [{ id: "effort", value: "invalid" }] },
    }),
  );
  assert.isNotNull(agentModelPolicy({ ...base, provider: undefined }));
});

it("rejects ambiguous model aliases rather than selecting a potentially unsafe model", () => {
  const collision = {
    ...provider,
    models: [
      ...provider.models,
      { ...provider.models[0]!, slug: "gpt-safe", name: "GPT", aliases: ["research-model"] },
    ],
  };
  assert.isNotNull(agentModelPolicy({ selection, provider: collision }));
});
