import type { MaintainVisibleContentPositionConfig } from "@legendapp/list/react-native";

import type { ThreadListV2ListItem } from "../threads/threadListV2";

/**
 * Android applies size corrections through native maintainVisibleContentPosition,
 * which jumps the scroll and restarts the fling whenever a row above the viewport
 * is measured, so scrolling up stalls once per row. Home rows have no fixed height.
 * iOS keeps LegendList's default ({ data: false, size: true }).
 */
export function homeThreadListMaintainVisibleContentPosition(
  platform: string,
): boolean | MaintainVisibleContentPositionConfig<ThreadListV2ListItem> {
  return platform === "android" ? false : { data: false, size: true };
}
