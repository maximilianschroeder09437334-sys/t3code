import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { BrowserRecoveryTracker } from "./BrowserRecovery.ts";

describe("BrowserRecoveryTracker", () => {
  it("requires fresh observations after each failed action and isolates threads", () => {
    const tracker = new BrowserRecoveryTracker();
    const one = ThreadId.make("browser-one");
    const two = ThreadId.make("browser-two");
    tracker.failed(one);
    expect(tracker.state(one)).toEqual({
      recoveryRequired: true,
      statusChecked: false,
      snapshotChecked: false,
    });
    expect(tracker.state(two).recoveryRequired).toBe(false);
    tracker.checkedStatus(one, tracker.generation(one));
    tracker.checkedSnapshot(one, tracker.generation(one));
    expect(tracker.state(one)).toEqual({
      recoveryRequired: true,
      statusChecked: true,
      snapshotChecked: true,
    });
    tracker.failed(one);
    expect(tracker.state(one).statusChecked).toBe(false);
    expect(tracker.state(one).snapshotChecked).toBe(false);
    tracker.succeeded(one, tracker.generation(one));
    expect(tracker.state(one).recoveryRequired).toBe(false);
  });
  it("does not let an older successful action erase a newer failure", () => {
    const tracker = new BrowserRecoveryTracker();
    const thread = ThreadId.make("browser-race");
    const beforeFailure = tracker.generation(thread);
    tracker.failed(thread);
    tracker.succeeded(thread, beforeFailure);
    tracker.checkedStatus(thread, beforeFailure);
    tracker.checkedSnapshot(thread, beforeFailure);
    expect(tracker.state(thread).recoveryRequired).toBe(true);
    expect(tracker.state(thread).statusChecked).toBe(false);
    expect(tracker.state(thread).snapshotChecked).toBe(false);
    const firstFailure = tracker.generation(thread);
    tracker.failed(thread);
    tracker.succeeded(thread, firstFailure);
    expect(tracker.state(thread).recoveryRequired).toBe(true);
  });
});
