import { assert, it } from "@effect/vitest";
import type { ServerProvider } from "@t3tools/contracts";
import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import {
  agentModelPolicy,
  agentSelectionMatchesRun,
  intentRunsUserPick,
  withAdvertisedDefaultEffort,
} from "./AgentModelPolicy.ts";

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

it("matches a run whose selection only adds a switched-off option to the agent's choice", () => {
  const intent: ModelSelection = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus-5-5",
    options: [{ id: "effort", value: "medium" }],
  };
  const withFastModeOff: ModelSelection = {
    ...intent,
    options: [...intent.options!, { id: "fastMode", value: false }],
  };
  assert.isTrue(agentSelectionMatchesRun(intent, withFastModeOff));
  assert.isTrue(agentSelectionMatchesRun(withFastModeOff, intent));
  assert.isFalse(
    agentSelectionMatchesRun(intent, {
      ...intent,
      options: [...intent.options!, { id: "fastMode", value: true }],
    }),
  );
  assert.isFalse(
    agentSelectionMatchesRun(intent, { ...intent, options: [{ id: "effort", value: "high" }] }),
  );
  assert.isFalse(agentSelectionMatchesRun(intent, { ...intent, model: "claude-haiku" }));
});

it("states the advertised default effort of a pick that leaves effort unset, and nothing else", () => {
  const withDefault = {
    instanceId: "claudeAgent",
    models: [
      {
        slug: "claude-opus-5-5",
        name: "Opus",
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              type: "select",
              options: [{ id: "low" }, { id: "medium", isDefault: true }],
            },
            { id: "fastMode", type: "boolean" },
          ],
        },
      },
    ],
  } as unknown as ServerProvider;
  const pick: ModelSelection = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus-5-5",
    options: [{ id: "fastMode", value: false }],
  };
  const stated = withAdvertisedDefaultEffort(pick, withDefault);
  assert.deepStrictEqual(stated.options, [
    { id: "fastMode", value: false },
    { id: "effort", value: "medium" },
  ]);
  assert.isNull(agentModelPolicy({ selection: stated, provider: withDefault }));
  // An effort the pick states stays, even an unadvertised one.
  const explicit = { ...pick, options: [{ id: "effort", value: "max" }] };
  assert.deepStrictEqual(withAdvertisedDefaultEffort(explicit, withDefault), explicit);
  // No advertised default, another provider, or no provider: unchanged.
  assert.deepStrictEqual(withAdvertisedDefaultEffort(pick, provider), pick);
  assert.deepStrictEqual(
    withAdvertisedDefaultEffort(
      { ...pick, instanceId: ProviderInstanceId.make("codex") },
      withDefault,
    ),
    { ...pick, instanceId: ProviderInstanceId.make("codex") },
  );
  assert.deepStrictEqual(withAdvertisedDefaultEffort(pick, undefined), pick);
});

it("counts an intent as a person's pick only while it still holds that pick", () => {
  const pick: ModelSelection = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus-5-5",
    options: [{ id: "fastMode", value: false }],
  };
  assert.isTrue(intentRunsUserPick({ modelSelection: pick, userModelSelection: pick }));
  assert.isTrue(
    intentRunsUserPick({
      modelSelection: { ...pick, options: [] },
      userModelSelection: pick,
    }),
  );
  assert.isFalse(intentRunsUserPick({ modelSelection: pick }));
  assert.isFalse(
    intentRunsUserPick({
      modelSelection: { ...pick, model: "claude-sonnet-5-5" },
      userModelSelection: pick,
    }),
  );
});
