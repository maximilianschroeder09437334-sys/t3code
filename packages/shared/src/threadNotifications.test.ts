import { expect, it } from "vite-plus/test";
import { shouldNotifyThread } from "./threadNotifications.ts";
it("keeps routine internal completions silent while allowing direct answers, input and explicit pings", () => {
  expect(shouldNotifyThread({ kind: "completion" })).toBe(false);
  expect(shouldNotifyThread({ kind: "completion", muted: true, humanAuthored: false })).toBe(false);
  expect(shouldNotifyThread({ kind: "failure", muted: true, humanAuthored: false })).toBe(false);
  expect(shouldNotifyThread({ kind: "completion", muted: true, humanAuthored: true })).toBe(true);
  expect(shouldNotifyThread({ kind: "input", muted: true })).toBe(true);
  expect(shouldNotifyThread({ kind: "completion", muted: true, explicitPing: true })).toBe(true);
  expect(shouldNotifyThread({ kind: "completion", muted: false })).toBe(true);
});
