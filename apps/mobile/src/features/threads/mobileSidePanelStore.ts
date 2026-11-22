import { useSyncExternalStore } from "react";

import type { MobileSurfaceId } from "./threadHeader.logic";

export type MobileSidePanelTabId = Exclude<MobileSurfaceId, "linked-pull-requests" | "device">;

export interface MobileSidePanelTabs {
  readonly tabs: ReadonlyArray<MobileSidePanelTabId>;
  readonly activeTab: MobileSidePanelTabId | null;
}

const EMPTY_TABS: MobileSidePanelTabs = { tabs: [], activeTab: null };
const snapshots = new Map<string, MobileSidePanelTabs>();
const listeners = new Map<string, Set<() => void>>();

function publish(key: string, next: MobileSidePanelTabs): void {
  if (next.tabs.length === 0) snapshots.delete(key);
  else snapshots.set(key, next);
  listeners.get(key)?.forEach((listener) => listener());
}

function getSnapshot(key: string): MobileSidePanelTabs {
  return snapshots.get(key) ?? EMPTY_TABS;
}

export const mobileSidePanelStore = {
  getSnapshot(key: string): MobileSidePanelTabs {
    return getSnapshot(key);
  },

  subscribe(key: string, listener: () => void): () => void {
    const bucket = listeners.get(key) ?? new Set<() => void>();
    bucket.add(listener);
    listeners.set(key, bucket);
    return () => {
      bucket.delete(listener);
      if (bucket.size === 0) listeners.delete(key);
    };
  },

  open(key: string, tab: MobileSidePanelTabId): void {
    const current = getSnapshot(key);
    const tabs = current.tabs.includes(tab) ? current.tabs : [...current.tabs, tab];
    if (tabs === current.tabs && current.activeTab === tab) return;
    publish(key, { tabs, activeTab: tab });
  },

  select(key: string, tab: MobileSidePanelTabId): void {
    const current = getSnapshot(key);
    if (!current.tabs.includes(tab) || current.activeTab === tab) return;
    publish(key, { ...current, activeTab: tab });
  },

  close(key: string, tab: MobileSidePanelTabId): void {
    const current = getSnapshot(key);
    if (!current.tabs.includes(tab)) return;
    const tabs = current.tabs.filter((entry) => entry !== tab);
    const activeTab = current.activeTab === tab ? (tabs.at(-1) ?? null) : current.activeTab;
    publish(key, { tabs, activeTab });
  },
};

export function useMobileSidePanelTabs(key: string): MobileSidePanelTabs {
  return useSyncExternalStore(
    (listener) => mobileSidePanelStore.subscribe(key, listener),
    () => getSnapshot(key),
    () => getSnapshot(key),
  );
}
