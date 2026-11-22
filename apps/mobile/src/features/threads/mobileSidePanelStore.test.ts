import { expect, it } from "vite-plus/test";

import {
  mobileAgentTabId,
  mobileAgentTabTarget,
  mobileSidePanelThreadLabel,
  mobileSidePanelThreadTarget,
  mobileSidePanelStore,
} from "./mobileSidePanelStore";

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

it("keeps lineage tabs scoped to each child environment during side-chat reconciliation", () => {
  const key = "environment-a:thread-d";
  const local = mobileAgentTabId("environment-a", "child-1");
  const remote = mobileAgentTabId("environment-b", "child-1");
  mobileSidePanelStore.open(key, local);
  mobileSidePanelStore.open(key, remote);
  mobileSidePanelStore.reconcile(key, new Set([local, remote]));

  expect(mobileAgentTabTarget(local)).toEqual({
    environmentId: "environment-a",
    threadId: "child-1",
  });
  expect(mobileAgentTabTarget(remote)).toEqual({
    environmentId: "environment-b",
    threadId: "child-1",
  });
  expect(mobileSidePanelThreadTarget("side-chat:child-1", "environment-a")).toEqual({
    environmentId: "environment-a",
    threadId: "child-1",
  });
  expect(mobileSidePanelThreadTarget(remote, "environment-a")).toEqual({
    environmentId: "environment-b",
    threadId: "child-1",
  });
  expect(mobileSidePanelThreadLabel(local, "environment-a")).toBe("Agent ild-1 · local");
  expect(mobileSidePanelThreadLabel(remote, "environment-a")).toBe("Agent ild-1 · nt-b");
  expect(mobileSidePanelStore.getSnapshot(key).tabs).toEqual([local, remote]);
});
