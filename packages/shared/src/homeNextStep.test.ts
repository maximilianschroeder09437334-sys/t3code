import { describe, expect, it } from "vite-plus/test";
import {
  firstHomeNextStepText,
  isHomeReportCurrent,
  parseHomeActionableMaxiStep,
  parseHomeNextStep,
  parseNextSteps,
} from "./homeNextStep.ts";

const FULL_REPORT = `Done with the parser.

**What happened**
- Maxi: this bullet is a result, not a step
- Tests pass (12/12).

**Next steps in order**
1. Maxi: approve the Home layout
2. T3: push the branch
3. Maxi: nothing needed right now.`;

describe("parseNextSteps", () => {
  it.each([
    [
      "global report format",
      FULL_REPORT,
      ["Maxi: approve the Home layout", "T3: push the branch", "Maxi: nothing needed right now."],
    ],
    [
      "plain heading with 1) numbering",
      "Next steps in order\n1) Maxi: try it\n2) T3: wait",
      ["Maxi: try it", "T3: wait"],
    ],
    [
      "markdown heading, bullets, CRLF and blank lines",
      "## Next steps in order\r\n\r\n-   Maxi:   check   the phone  \r\n\r\n* T3: continue\r\n",
      ["Maxi: check the phone", "T3: continue"],
    ],
    [
      "bold heading with colon and bold owners",
      "**Next steps in order:**\n1. **Maxi:** merge it\n2. **T3**: watch CI\n3. **Maxi: reply here**",
      ["Maxi: merge it", "T3: watch CI", "Maxi: reply here"],
    ],
    [
      "unnumbered owner line",
      "**Next steps in order**\nMaxi: nothing needed right now.",
      ["Maxi: nothing needed right now."],
    ],
    [
      "prose before the list, nested detail, wrapped line, next heading",
      "**Next steps in order**\nIn this order:\n1. Maxi: review the\n   long proposal\n   - detail that is not a step\n2. T3: ship\n\n**Notes**\n1. Maxi: not a step",
      ["Maxi: review the long proposal", "T3: ship"],
    ],
    [
      "closing prose ends the list",
      "**Next steps in order**\n1. T3: ship\nThanks!\n2. Maxi: not a step",
      ["T3: ship"],
    ],
    [
      "last heading wins over a quoted earlier report",
      "Earlier:\n**Next steps in order**\n1. Maxi: old ask\n\nNow:\n**Next steps in order**\n1. T3: new plan",
      ["T3: new plan"],
    ],
    ["empty section", "**Next steps in order**\n\n", []],
  ])("reads %s", (_name, report, steps) => {
    expect(parseNextSteps(report)).toEqual(steps);
  });

  it("returns null without the section", () => {
    expect(parseNextSteps("**What happened**\n- Maxi: looked at it")).toBeNull();
    expect(parseNextSteps("Next steps: 1. Maxi: do it")).toBeNull();
  });
});

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
    expect(parseHomeNextStep(FULL_REPORT.replace("1. Maxi: approve", "1. T3: approve"))).toBeNull();
  });
  it("treats any nothing-needed wording as no ask", () => {
    for (const step of [
      "Maxi: nothing needed right now",
      "Maxi: Nothing needed right now (all pushed).",
      "**Maxi:** nothing needed.",
    ])
      expect(parseHomeNextStep(`**Next steps in order**\n1. ${step}`)).toEqual({ kind: "none" });
  });
  it("reads the ask from full reports and from the stored single step", () => {
    expect(parseHomeNextStep(FULL_REPORT)).toEqual({
      kind: "needs",
      text: "approve the Home layout",
    });
    expect(parseHomeNextStep("Maxi: approve the Home layout")).toEqual({
      kind: "needs",
      text: "approve the Home layout",
    });
  });
  it("ignores a multi-line report without the section even if it starts with Maxi:", () => {
    expect(firstHomeNextStepText("Maxi: here is what I did\n\nMore detail.")).toBeNull();
    expect(parseHomeNextStep("Maxi: here is what I did\n\nMore detail.")).toBeNull();
  });
  it("finds an actionable Maxi step after earlier T3 work", () => {
    expect(
      parseHomeActionableMaxiStep(
        "**Next steps in order**\n1. T3: continue building\n2. Maxi: test this version meanwhile\n3. Maxi: nothing needed right now.",
      ),
    ).toBe("test this version meanwhile");
  });
});

it("stops using a completed report after a newer run or Maxi reply", () => {
  expect(
    isHomeReportCurrent({
      reportRunId: "run-1",
      latestRunId: "run-2",
      reportCompletedAt: 10,
      latestUserMessageAt: null,
    }),
  ).toBe(false);
  expect(
    isHomeReportCurrent({
      reportRunId: "run-1",
      latestRunId: "run-1",
      reportCompletedAt: 10,
      latestUserMessageAt: 11,
    }),
  ).toBe(false);
  expect(
    isHomeReportCurrent({
      reportRunId: "run-1",
      latestRunId: "run-1",
      reportCompletedAt: 10,
      latestUserMessageAt: null,
    }),
  ).toBe(true);
});
