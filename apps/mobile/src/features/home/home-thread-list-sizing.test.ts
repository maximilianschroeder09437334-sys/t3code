import { describe, expect, it } from "vite-plus/test";

import { homeThreadListMaintainVisibleContentPosition } from "./home-thread-list-sizing";

describe("homeThreadListMaintainVisibleContentPosition", () => {
  it("turns off native size corrections on Android", () => {
    expect(homeThreadListMaintainVisibleContentPosition("android")).toBe(false);
  });

  it("keeps LegendList's default size correction on iOS", () => {
    expect(homeThreadListMaintainVisibleContentPosition("ios")).toEqual({
      data: false,
      size: true,
    });
  });
});
