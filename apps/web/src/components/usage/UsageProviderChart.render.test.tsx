import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { UsageProviderChart } from "./UsageProviderChart";

const daily = [
  {
    day: "2026-11-21",
    costUsd: 170,
    totalTokens: 0,
    byProvider: new Map([
      ["claude" as const, { costUsd: 100, totalTokens: 0 }],
      ["codex" as const, { costUsd: 70, totalTokens: 0 }],
    ]),
  },
];

function render(metric: "cost" | "share") {
  return renderToStaticMarkup(
    createElement(UsageProviderChart, {
      providers: ["claude", "codex"],
      days: ["2026-11-21"],
      daily,
      hours: [],
      hourly: [],
      metric,
      shareRates: new Map([
        ["claude" as const, 1000],
        ["codex" as const, 350],
      ]),
      shareLabel: "weekly limit",
      referenceTime: undefined,
      resolution: "day",
      timeZone: "UTC",
      hour12: false,
    }),
  );
}

describe("UsageProviderChart share metric", () => {
  it("shows each provider's own share and no total across pools", () => {
    const markup = render("share");
    expect(markup).toContain("<td>10%</td>");
    expect(markup).toContain("<td>20%</td>");
    expect(markup).not.toContain(">Total<");
    expect(markup).not.toContain("30%");
  });

  it("keeps the total for cost", () => {
    expect(render("cost")).toContain(">Total<");
  });
});
