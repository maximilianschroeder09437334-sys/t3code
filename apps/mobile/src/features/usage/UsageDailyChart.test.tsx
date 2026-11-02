import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({
    children,
    accessibilityLabel,
    onPress,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    onPress?: () => void;
  }) => (
    <button aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("./usageProviders", () => ({
  PROVIDER_ORDER: ["codex"],
  useProviderColors: () => ({ codex: "#fff" }),
}));

import { UsageDailyChart } from "./UsageDailyChart";

it("selects the requested period, including a day with no recorded activity", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const select = vi.fn();
  try {
    await act(async () => {
      root.render(
        <UsageDailyChart
          days={["2026-10-31", "2026-11-01"]}
          daily={[
            {
              day: "2026-10-31",
              totalTokens: 123,
              costUsd: 0.04,
              byProvider: new Map([["codex", { totalTokens: 123, costUsd: 0.04 }]]),
            },
          ]}
          metric="tokens"
          height={100}
          selectedDay={null}
          onSelectDay={select}
        />,
      );
    });
    const first = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show usage for 2026-10-31"]',
    );
    const second = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show usage for 2026-11-01"]',
    );
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    await act(async () => first!.click());
    await act(async () => second!.click());
    expect(select.mock.calls).toEqual([["2026-10-31"], ["2026-11-01"]]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
