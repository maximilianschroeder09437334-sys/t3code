import type { MaintainVisibleContentPositionConfig } from "@legendapp/list/react-native";

import type { ThreadListV2ListItem } from "../threads/threadListV2";

/**
 * Card and slim thread rows differ in height by a full title line or more, so
 * they get separate LegendList types: each keeps its own measured average, and
 * a row that has not been measured yet is estimated from rows of its own kind.
 */
export function homeThreadListItemType(item: ThreadListV2ListItem): string {
  return item.type === "v2-thread" ? `v2-thread:${item.item.variant}` : item.type;
}

/**
 * Android applies size corrections through native maintainVisibleContentPosition,
 * which jumps the scroll and restarts the fling whenever a row above the viewport
 * is measured, so scrolling up stalls once per row. Home rows have no fixed height.
 */
export function homeThreadListMaintainVisibleContentPosition(
  platform: string,
): boolean | MaintainVisibleContentPositionConfig<ThreadListV2ListItem> {
  return platform === "android" ? false : { data: false, size: true };
}
