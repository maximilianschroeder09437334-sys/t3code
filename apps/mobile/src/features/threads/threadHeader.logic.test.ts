import { expect, it } from "vite-plus/test";
import { mobileThreadSurfaces } from "./threadHeader.logic";

it("keeps the desktop surface order and marks unavailable mobile surfaces", () => {
  const items = mobileThreadSurfaces({
    canOpenTerminal: true,
    canOpenFiles: false,
    isGitRepo: true,
    hasPullRequest: false,
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
    "Terminal",
    "Diff",
  ]);
  expect(items.find((item) => item.id === "browser")).toMatchObject({
    available: false,
    reason: "Not on mobile yet",
  });
});
