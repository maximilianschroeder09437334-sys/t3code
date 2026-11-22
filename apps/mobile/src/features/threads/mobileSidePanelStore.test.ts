import { expect, it } from "vite-plus/test";

import { mobileSidePanelStore } from "./mobileSidePanelStore";

it("opens and switches surface tabs per thread", () => {
  const key = "environment-a:thread-a";
  mobileSidePanelStore.open(key, "browser");
  mobileSidePanelStore.open(key, "files");
  mobileSidePanelStore.select(key, "browser");

  expect(mobileSidePanelStore.getSnapshot(key)).toEqual({
    tabs: ["browser", "files"],
    activeTab: "browser",
  });
  expect(mobileSidePanelStore.getSnapshot("environment-b:thread-a").tabs).toEqual([]);
});

it("closes a tab and selects the last remaining tab when active", () => {
  const key = "environment-a:thread-b";
  mobileSidePanelStore.open(key, "terminal");
  mobileSidePanelStore.open(key, "diff");
  mobileSidePanelStore.close(key, "diff");

  expect(mobileSidePanelStore.getSnapshot(key)).toEqual({
    tabs: ["terminal"],
    activeTab: "terminal",
  });

  mobileSidePanelStore.close(key, "terminal");
  expect(mobileSidePanelStore.getSnapshot(key)).toEqual({ tabs: [], activeTab: null });
});

it("closes the active tab to its right-hand neighbor and drops stale side chats", () => {
  const key = "environment-a:thread-c";
  mobileSidePanelStore.open(key, "browser");
  mobileSidePanelStore.open(key, "files");
  mobileSidePanelStore.open(key, "terminal");
  mobileSidePanelStore.select(key, "files");
  mobileSidePanelStore.close(key, "files");
  expect(mobileSidePanelStore.getSnapshot(key).activeTab).toBe("terminal");

  mobileSidePanelStore.open(key, "side-chat:child-1");
  mobileSidePanelStore.reconcile(key, new Set(["browser", "terminal"]));
  expect(mobileSidePanelStore.getSnapshot(key)).toEqual({
    tabs: ["browser", "terminal"],
    activeTab: "terminal",
  });
});
