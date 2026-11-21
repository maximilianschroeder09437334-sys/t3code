import { describe, expect, it } from "@effect/vitest";
import { handoffFirstStepOwner, handoffNeedsUser } from "./HandoffNextStep.ts";

describe("handoffFirstStepOwner", () => {
  it.each([
    ["**Next steps in order**\n1. Codex: Continue working.", "codex"],
    ["## Next steps in order\n\n1. Maxi: Review this.\n2. Codex: Continue.", "maxi"],
    ["Next steps in order:\n- **Codex:** Continue.", "codex"],
    ["Next steps in order:\n1. **Codex**: Continue.", "codex"],
    ["Next steps in order\n1. Worker: Finish the task.", "other"],
    ["```\n**Next steps in order**\n1. Codex: Example.\n```", null],
    ["**Next steps in order**\nWaiting for approval.\n1. Codex: Continue.", null],
    ["**Next steps in order**\n2. Codex: Continue.", null],
    ["Codex: Continue.", null],
  ] as const)("parses only an explicit first step", (text, expected) => {
    expect(handoffFirstStepOwner(text)).toBe(expected);
  });
});

describe("handoffNeedsUser", () => {
  it.each([
    ["What should the hook do?\n\nNext steps in order\n1. Codex: Draft it after you answer.", true],
    ["Waiting for your approval.\n\nNext steps in order\n1. Codex: Continue.", true],
    ["Requires approval before installation.\n\nNext steps in order\n1. Codex: Continue.", true],
    ["Next steps in order\n1. Codex: Continue.\n2. Maxi: nothing needed right now.", false],
    ["```\nWhat should this code do?\n```\nNext steps in order\n1. Codex: Continue.", false],
  ] as const)("preserves requests for user action", (text, expected) => {
    expect(handoffNeedsUser(text)).toBe(expected);
  });
});
