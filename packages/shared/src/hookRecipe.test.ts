import { expect, it } from "vite-plus/test";
import { compileHookRecipe, hookRecipeTemplates, matchesHookCondition } from "./hookRecipe.ts";

it("checks only owned payload fields and rejects prototype paths", () => {
  expect(
    matchesHookCondition(
      { estimateSeconds: 30 },
      { path: "estimateSeconds", operator: "at-least", value: 10 },
    ),
  ).toBe(true);
  expect(matchesHookCondition({}, { path: "missing", operator: "exists" })).toBe(false);
  expect(matchesHookCondition({}, { path: "constructor", operator: "exists" })).toBe(false);
});
it("compiles reviewed recipes into inert draft scripts with deterministic decisions", () => {
  const script = compileHookRecipe(
    hookRecipeTemplates.find((template) => template.id === "computer-use")!.recipe,
  );
  const run = new Function("input", script);
  expect(run({ payload: { estimateSeconds: 60 } })).toEqual({ decision: "allow" });
  expect(run({ payload: { estimateSeconds: 3601 } }).decision).toBe("block");
  expect(run({ payload: {} }).decision).toBe("block");
  const warn = new Function(
    "input",
    compileHookRecipe(hookRecipeTemplates.find((template) => template.id === "report")!.recipe),
  );
  expect(warn({ payload: {} }).decision).toBe("warn");
  const recover = new Function(
    "input",
    compileHookRecipe(hookRecipeTemplates.find((template) => template.id === "stalled")!.recipe),
  );
  expect(recover({ payload: { overdue: true } }).recovery).toMatchObject({
    allowIdleResume: true,
    maxAttempts: 2,
    deadlineSeconds: 300,
  });
  expect(recover({ payload: { overdue: false } })).toEqual({ decision: "allow" });
});
