import { expect, it } from "@effect/vitest";
import { computerUseOperation } from "./hookToolBridge.ts";
it("requires an estimate for known computer tools while allowing the exact release call", () => {
  expect(computerUseOperation("mcp__cua_repl__js", { code: "await cua.getState()" })).toBe("use");
  expect(
    computerUseOperation("mcp__cua_repl__js", {
      completion_summary: "Finished checking the layout",
    }),
  ).toBe("end");
  expect(
    computerUseOperation("mcp__cua_repl__js", { completion_summary: "Done", code: "input()" }),
  ).toBe("use");
  expect(computerUseOperation("node_repl", { code: 'await import("@oai/sky")' })).toBe("use");
  expect(computerUseOperation("Bash", { command: "git status" })).toBeNull();
});
