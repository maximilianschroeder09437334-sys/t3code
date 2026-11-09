import type { HookCondition, HookRecipe } from "@t3tools/contracts";

export function matchesHookCondition(payload: unknown, condition: HookCondition): boolean {
  let value: unknown = payload;
  for (const segment of condition.path.split(".")) {
    if (["__proto__", "prototype", "constructor"].includes(segment)) return false;
    if (typeof value !== "object" || value === null || !Object.hasOwn(value, segment)) {
      value = undefined;
      break;
    }
    value = Reflect.get(value, segment);
  }
  switch (condition.operator) {
    case "exists":
      return (value !== undefined && value !== null) === (condition.value !== false);
    case "equals":
      return value === condition.value;
    case "not-equals":
      return value !== condition.value;
    case "includes":
      return (
        typeof value === "string" &&
        typeof condition.value === "string" &&
        value.includes(condition.value)
      );
    case "at-least":
      return (
        typeof value === "number" && typeof condition.value === "number" && value >= condition.value
      );
    case "at-most":
      return (
        typeof value === "number" && typeof condition.value === "number" && value <= condition.value
      );
  }
}

export function compileHookRecipe(recipe: HookRecipe): string {
  if (
    recipe.onFailure === "repair" &&
    (!["turn_end", "thread_stalled"].includes(recipe.event) || recipe.repair === undefined)
  ) {
    throw new Error(
      "Prompt repair is supported at turn end and for registered stalled work; choose block or warn for a pre-action check.",
    );
  }
  return `// Description: ${recipe.description.replaceAll("\n", " ")}\nconst recipe = ${JSON.stringify(recipe)};\nconst matches = ${matchesHookCondition.toString()};\nif (!recipe.when.every(c => matches(input.payload, c)) || recipe.check.every(c => matches(input.payload, c))) return { decision: "allow" };\nif (recipe.onFailure === "repair" && recipe.event === "thread_stalled") return { decision: "allow", message: recipe.message, recovery: { ...recipe.repair, allowIdleResume: recipe.repair.allowIdleResume === true } };\nreturn { decision: recipe.onFailure === "warn" ? "warn" : "block", message: recipe.message, ...(recipe.onFailure === "repair" ? { repair: recipe.repair } : {}) };`;
}

export const hookRecipeTemplates: ReadonlyArray<{
  readonly id: string;
  readonly name: string;
  readonly recipe: HookRecipe;
}> = [
  {
    id: "stalled",
    name: "Recover registered unfinished work",
    recipe: {
      version: 1,
      description:
        "Repair an overdue registered obligation within two attempts and five minutes, then verify or escalate.",
      event: "thread_stalled",
      when: [],
      check: [{ path: "overdue", operator: "equals", value: false }],
      onFailure: "repair",
      message: "Verify the unfinished work; preserve Stop, questions, queues and usage limits.",
      repair: {
        prompt:
          "Inspect the latest receipt and failed step. Try a distinct reversible repair within the original authorized scope and verify it. Use t3_hook_work to report progress, wait, completion or cancellation; use t3_user_ping if only the human can resolve the blocker.",
        maxAttempts: 2,
        deadlineSeconds: 300,
        allowIdleResume: true,
      },
    },
  },
  {
    id: "computer-use",
    name: "Computer use estimate and timer",
    recipe: {
      version: 1,
      description: "Require an agent estimate before managed computer use.",
      event: "resource_start",
      when: [],
      check: [
        { path: "estimateSeconds", operator: "at-least", value: 10 },
        { path: "estimateSeconds", operator: "at-most", value: 600 },
      ],
      onFailure: "block",
      message:
        "Name a realistic estimate between 10 and 600 seconds; renew or end the session after the host timer expires.",
    },
  },
  {
    id: "branch",
    name: "Protect the main branch",
    recipe: {
      version: 1,
      description: "Keep managed pushes on feature branches.",
      event: "before_github_push",
      when: [],
      check: [
        { path: "branch", operator: "not-equals", value: "main" },
        { path: "branch", operator: "not-equals", value: "master" },
      ],
      onFailure: "block",
      message:
        "Use the authorized feature branch, verify the backup and checks, then push and verify the remote commit.",
    },
  },
  {
    id: "report",
    name: "Report guidance without blocking work",
    recipe: {
      version: 1,
      description: "Warn when the next action has no owner.",
      event: "turn_end",
      when: [],
      check: [{ path: "firstNextStepOwner", operator: "exists" }],
      onFailure: "warn",
      message: "Give the next action an owner and keep the report concise.",
    },
  },
  {
    id: "repair",
    name: "Repair an unfinished agent step",
    recipe: {
      version: 1,
      description:
        "Continue an explicitly unfinished agent-owned step within two attempts and five minutes.",
      event: "turn_end",
      when: [{ path: "firstNextStepOwner", operator: "equals", value: "codex" }],
      check: [{ path: "unfinishedWork", operator: "equals", value: false }],
      onFailure: "repair",
      message: "Verify the next authorized step or explain the concrete blocker.",
      repair: {
        prompt:
          "Continue the authorized unfinished step. Try a different reversible repair, verify the result, and preserve human Stop, approvals and limits.",
        maxAttempts: 2,
        deadlineSeconds: 300,
      },
    },
  },
];
