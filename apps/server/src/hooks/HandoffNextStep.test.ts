import { describe, expect, it } from "@effect/vitest";
import {
  handoffFirstStepOwner,
  handoffNeedsUser,
  userRequestedFullStopHold,
  userRequestedPauseOrWait,
} from "./HandoffNextStep.ts";

describe("handoffFirstStepOwner", () => {
  it.each([
    ["**Next steps in order**\n1. Codex: Continue working.", "codex"],
    ["## Next steps in order\n\n1. Maxi: Review this.\n2. Codex: Continue.", "maxi"],
    ["Next steps in order:\n- **Codex:** Continue.", "codex"],
    ["Next steps in order:\n1. **Codex**: Continue.", "codex"],
    ["Next steps in order\n1. Worker: Finish the task.", "other"],
    ["**Next steps in order**\n1. [Thread: Worker; ref=thread_worker]: Finish the task.", "other"],
    ["**Next steps in order**\n1. Codex: WAIT on [Thread: Worker; ref=thread_worker].", "codex"],
    [
      "**Next steps in order**\n1. Codex: [Thread: Worker; ref=thread_worker]: Finish the task.",
      "codex",
    ],
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
    ["Approval required before installation.\n\nNext steps in order\n1. Codex: Continue.", true],
    [
      "Blocked pending user approval before installation.\n\nNext steps in order\n1. Codex: Continue.",
      true,
    ],
    ["Next steps in order\n1. Codex: Continue.\n2. Maxi: nothing needed right now.", false],
    ["```\nWhat should this code do?\n```\nNext steps in order\n1. Codex: Continue.", false],
  ] as const)("preserves requests for user action", (text, expected) => {
    expect(handoffNeedsUser(text)).toBe(expected);
  });
});

describe("continuation holds", () => {
  it.each([
    ["Full Stop: continue preparation and validation in staging.", false],
    ["Please Stop and wait for me.", true],
    ["I need to sleep, so please stop now.", true],
    ["Wait for the linked T3 thread before starting.", true],
    ["Work on X, then wait for Y.", false],
    ["Full Stop now: continue preparation and validation in staging.", false],
  ] as const)("checks the first requested action in %j", (text, expected) => {
    expect(userRequestedPauseOrWait(text)).toBe(expected);
  });

  it("holds staged-file installation during Full Stop", () => {
    expect(userRequestedFullStopHold("Full Stop: prepare only.")).toBe(true);
    expect(userRequestedFullStopHold("Continue with staged validation.")).toBe(false);
  });
});
