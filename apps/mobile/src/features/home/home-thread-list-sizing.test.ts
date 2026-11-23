import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import type { ThreadListV2ListItem } from "../threads/threadListV2";
import {
  homeThreadListItemType,
  homeThreadListMaintainVisibleContentPosition,
} from "./home-thread-list-sizing";

function threadRow(variant: "card" | "slim"): ThreadListV2ListItem {
  const thread = makeThreadShellFixture({
    environmentId: EnvironmentId.make("environment-1"),
    id: ThreadId.make(`thread-${variant}`),
    title: variant,
  });
  return {
    type: "v2-thread",
    key: `thread-${variant}`,
    item: { thread, variant, snoozed: false, pinned: false, wokeAt: null, isLast: false },
    snoozeWakeLabelText: undefined,
    timeLabel: "1m",
    snoozePresetMinute: undefined,
    showTrailingDivider: true,
    hasQueuedMessages: false,
    canMoveUp: false,
    canMoveDown: false,
  };
}

describe("homeThreadListItemType", () => {
  it("keeps card and slim thread rows in separate size averages", () => {
    expect(homeThreadListItemType(threadRow("card"))).toBe("v2-thread:card");
    expect(homeThreadListItemType(threadRow("slim"))).toBe("v2-thread:slim");
  });

  it("keeps shelf headers on their own type", () => {
    expect(
      homeThreadListItemType({
        type: "v2-settled-shelf",
        key: "v2-settled-shelf",
        count: 3,
        expanded: false,
        disabled: false,
      }),
    ).toBe("v2-settled-shelf");
  });
});

describe("homeThreadListMaintainVisibleContentPosition", () => {
  it("turns off native size corrections on Android only", () => {
    expect(homeThreadListMaintainVisibleContentPosition("android")).toBe(false);
    expect(homeThreadListMaintainVisibleContentPosition("ios")).toEqual({
      data: false,
      size: true,
    });
  });
});
