import { describe, expect, it } from "vite-plus/test";
import { classifyHomeNotification, isNewHomeNotification } from "./homeNotificationRules.ts";

const input = {
  threadId: "thread-1",
  runId: "run-1",
  isChild: false,
  sideChat: false,
  snoozed: false,
  settled: false,
  needsYou: false,
  askText: null,
  turnCompleted: false,
  hasRunningChildren: false,
  waiting: false,
  hasAutoWait: false,
  handedOff: false,
  doneText: "Changes are ready",
} as const;

describe("classifyHomeNotification", () => {
  it("notifies for a Maxi ask while work continues", () => {
    expect(
      classifyHomeNotification({ ...input, needsYou: true, askText: "Test this version" }),
    ).toMatchObject({ kind: "needs", text: "Test this version" });
  });

  it.each([
    ["handoff", { handedOff: true }],
    ["WAIT", { waiting: true }],
    ["active child", { hasRunningChildren: true }],
    ["child thread", { isChild: true }],
    ["side chat", { sideChat: true }],
    ["snoozed", { snoozed: true }],
    ["settled", { settled: true }],
  ])("suppresses %s events", (_label, override) => {
    expect(classifyHomeNotification({ ...input, turnCompleted: true, ...override })).toBeNull();
  });

  it("notifies once for an unblocked completed turn", () => {
    const event = classifyHomeNotification({ ...input, turnCompleted: true });
    expect(event).toMatchObject({ kind: "done", text: "Changes are ready" });
    expect(isNewHomeNotification(null, event)).toBe(true);
    expect(isNewHomeNotification(event?.key ?? null, event)).toBe(false);
  });
});
