import { expect, it } from "vite-plus/test";
import {
  deferUntilModalDismiss,
  formatContextUsage,
  mobileThreadSurfaces,
  runAfterModalDismiss,
} from "./threadHeader.logic";

it("formats context usage in compact token units", () => {
  expect(formatContextUsage(136_000, 1_000_000)).toBe("136k / 1m");
  expect(formatContextUsage(1_250_000, null)).toBe("1.3m / unknown");
});

it("keeps the desktop surface order and marks unavailable mobile surfaces", () => {
  const items = mobileThreadSurfaces({
    canOpenTerminal: true,
    canOpenFiles: false,
    canOpenBrowser: true,
    isGitRepo: true,
    hasPullRequest: false,
    hasSideChat: true,
  });

  expect(items.map((item) => item.label)).toEqual([
    "Browser",
    "Terminal",
    "Files",
    "Diff",
    "Pull request",
    "Linked pull requests",
    "Device",
    "Side chat",
  ]);
  expect(items.filter((item) => item.available).map((item) => item.label)).toEqual([
    "Browser",
    "Terminal",
    "Diff",
    "Side chat",
  ]);
  expect(items.find((item) => item.id === "browser")).toMatchObject({ available: true });
});

it("runs lineage navigation only after the modal dismisses", () => {
  const events: string[] = [];
  const pending = deferUntilModalDismiss(() => events.push("navigate"));

  expect(events).toEqual([]);
  events.push("dismiss");
  runAfterModalDismiss(pending);

  expect(events).toEqual(["dismiss", "navigate"]);
});
