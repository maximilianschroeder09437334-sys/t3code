import { describe, expect, it } from "vite-plus/test";
import { parseHomeActionableMaxiStep, parseHomeNextStep } from "./homeNextStep.ts";

describe("parseHomeNextStep", () => {
  it("reads only the first Maxi action", () => {
    expect(
      parseHomeNextStep("**Next steps in order**\n1. Maxi: Review the result\n2. T3: continue"),
    ).toEqual({ kind: "needs", text: "Review the result" });
  });
  it("recognizes nothing needed", () => {
    expect(
      parseHomeNextStep("**Next steps in order**\n1. Maxi: nothing needed right now."),
    ).toEqual({ kind: "none" });
  });
  it("parses and decodes the linked environment and thread", () => {
    expect(
      parseHomeNextStep(
        "**Next steps in order**\n1. T3: WAIT on [Phone](https://app.t3.codes/threads/env-1/thread%3Aid) then continue",
      ),
    ).toEqual({ kind: "wait", title: "Phone", environmentId: "env-1", threadId: "thread:id" });
  });
  it("returns null when the first item is not actionable", () => {
    expect(parseHomeNextStep("Nothing here")).toBeNull();
    expect(parseHomeNextStep("**Next steps in order**\n1. T3: Continue")).toBeNull();
  });
  it("finds an actionable Maxi step after earlier T3 work", () => {
    expect(
      parseHomeActionableMaxiStep(
        "**Next steps in order**\n1. T3: continue building\n2. Maxi: test this version meanwhile\n3. Maxi: nothing needed right now.",
      ),
    ).toBe("test this version meanwhile");
  });
});
