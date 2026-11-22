// @effect-diagnostics globalDate:off -- Fixed instants keep window and bucket assertions deterministic.
import type { ServerProviderUsageWindow, UsageProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  calibrateWindow,
  costSince,
  currentWindowStart,
  dailyCostPeriods,
  detectPlan,
  estimateProviderLimits,
  formatLimitShare,
  hourlyCostPeriods,
  limitShare,
  mainLimitWindow,
  rememberCalibrations,
  resolvePlan,
  resolveRate,
  SUBSCRIPTION_PLANS,
  zonedDayStartMs,
} from "./usageEstimate.ts";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const plan = (id: string) => SUBSCRIPTION_PLANS.find((entry) => entry.id === id)!;

function window(overrides: Partial<ServerProviderUsageWindow>): ServerProviderUsageWindow {
  return { id: "w", kind: "weekly", label: "Weekly", usedPercent: 0, ...overrides };
}

function costs(provider: UsageProviderKind, costUsd: number) {
  return new Map([[provider, { costUsd }]]);
}

describe("detectPlan", () => {
  it("reads Claude subscriptions from auth type and label", () => {
    expect(detectPlan("claude", { type: "claude_max_20x_subscription" })).toBe("claude-ultra");
    expect(detectPlan("claude", { label: "Claude Ultra Subscription" })).toBe("claude-ultra");
    expect(detectPlan("claude", { type: "max", label: "Claude Max Subscription" })).toBe(
      "claude-max",
    );
    expect(detectPlan("claude", { type: "pro" })).toBe("claude-pro");
    expect(detectPlan("claude", { type: "apiKey", label: "Claude API Key" })).toBeNull();
    expect(detectPlan("claude", undefined)).toBeNull();
  });

  it("reads ChatGPT plans from the Codex auth label", () => {
    expect(detectPlan("codex", { label: "ChatGPT Pro 200 Subscription" })).toBe("codex-pro-200");
    expect(detectPlan("codex", { label: "ChatGPT Pro 100 Subscription" })).toBe("codex-pro-100");
    expect(detectPlan("codex", { label: "ChatGPT Pro 500 Subscription" })).toBe("codex-pro-500");
    expect(detectPlan("codex", { label: "ChatGPT Plus Subscription" })).toBe("codex-plus");
    expect(detectPlan("codex", { label: "OpenAI API Key" })).toBeNull();
  });
});

describe("resolvePlan", () => {
  it("prefers the setting, then detection, then the provider default", () => {
    expect(resolvePlan("claude", "claude-pro", "claude-ultra")).toMatchObject({
      plan: { id: "claude-pro" },
      source: "setting",
    });
    expect(resolvePlan("claude", undefined, "claude-ultra")).toMatchObject({
      plan: { id: "claude-ultra" },
      source: "detected",
    });
    expect(resolvePlan("codex", "claude-pro", null)).toMatchObject({
      plan: { id: "codex-plus" },
      source: "default",
    });
  });
});

describe("limit windows", () => {
  it("ignores model-scoped pools when picking the provider-wide window", () => {
    const windows = [
      window({ id: "fable", modelIds: ["claude-fable-5-2"], usedPercent: 90 }),
      window({ id: "seven_day", usedPercent: 30 }),
      window({ id: "five_hour", kind: "session", usedPercent: 12 }),
    ];
    expect(mainLimitWindow(windows, "weekly")?.id).toBe("seven_day");
    expect(mainLimitWindow(windows, "session")?.id).toBe("five_hour");
  });

  it("derives the start from the reset and the duration, and drops expired windows", () => {
    const resetsAt = new Date(NOW + 2 * HOUR).toISOString();
    expect(currentWindowStart(window({ kind: "session", resetsAt }), "session", NOW)).toBe(
      NOW - 3 * HOUR,
    );
    expect(
      currentWindowStart(window({ resetsAt, windowDurationMins: 60 * 24 }), "weekly", NOW),
    ).toBe(NOW + 2 * HOUR - 24 * HOUR);
    expect(
      currentWindowStart(window({ resetsAt: new Date(NOW - 1).toISOString() }), "weekly", NOW),
    ).toBeNull();
  });
});

describe("costSince", () => {
  it("counts whole buckets inside the window and the overlapping share of the first", () => {
    const periods = hourlyCostPeriods(
      [
        { hourStart: new Date(NOW - 3 * HOUR).toISOString(), byProvider: costs("claude", 10) },
        { hourStart: new Date(NOW - 2 * HOUR).toISOString(), byProvider: costs("claude", 4) },
        { hourStart: new Date(NOW - HOUR).toISOString(), byProvider: costs("codex", 99) },
      ],
      "claude",
    );
    expect(costSince(periods, NOW - 2.5 * HOUR, NOW)).toBeCloseTo(5 + 4);
  });

  it("spreads the current bucket only up to now", () => {
    const periods = [{ startMs: NOW - HOUR, endMs: NOW + 23 * HOUR, costUsd: 12 }];
    expect(costSince(periods, NOW - HOUR / 2, NOW)).toBeCloseTo(6);
  });

  it("buckets days at the time zone's midnight", () => {
    expect(new Date(zonedDayStartMs("2026-11-22", "Europe/Berlin")).toISOString()).toBe(
      "2026-11-21T23:00:00.000Z",
    );
    expect(new Date(zonedDayStartMs("2026-07-01", "Europe/Berlin")).toISOString()).toBe(
      "2026-06-30T22:00:00.000Z",
    );
    const periods = dailyCostPeriods(
      [{ day: "2026-11-21", byProvider: costs("codex", 24) }],
      "codex",
      "UTC",
    );
    expect(costSince(periods, Date.parse("2026-11-21T18:00:00.000Z"), NOW)).toBeCloseTo(6);
  });
});

describe("calibrateWindow", () => {
  it("divides API cost by the observed share", () => {
    expect(
      calibrateWindow({ measure: "weekly", usedPercent: 25, costUsd: 400, publicUsd: 1600 }),
    ).toEqual({ kind: "calibrated", usdPerWindow: 1600, usedPercent: 25 });
  });

  it("refuses thin windows", () => {
    expect(
      calibrateWindow({ measure: "weekly", usedPercent: 3, costUsd: 400, publicUsd: 1600 }),
    ).toEqual({ kind: "thin" });
    expect(
      calibrateWindow({ measure: "session", usedPercent: 40, costUsd: 0.5, publicUsd: 280 }),
    ).toEqual({ kind: "thin" });
  });

  it("flags results far from the public figure", () => {
    expect(
      calibrateWindow({ measure: "weekly", usedPercent: 50, costUsd: 20, publicUsd: 1600 }),
    ).toMatchObject({ kind: "outOfRange", usdPerWindow: 40 });
  });
});

describe("resolveRate", () => {
  const base = {
    measure: "weekly" as const,
    plan: plan("claude-ultra"),
    hasLimitData: true,
    windowPresent: true,
    remembered: undefined,
    nowMs: NOW,
  };

  it("falls back from calibrated to remembered to public", () => {
    expect(
      resolveRate({
        ...base,
        calibration: { kind: "calibrated", usdPerWindow: 1800, usedPercent: 20 },
      }),
    ).toMatchObject({ basis: "calibrated", usdPerWindow: 1800 });
    const remembered = {
      usdPerWindow: 1700,
      usedPercent: 40,
      at: NOW - HOUR,
      planId: "claude-ultra",
    };
    expect(resolveRate({ ...base, calibration: { kind: "thin" }, remembered })).toMatchObject({
      basis: "remembered",
      usdPerWindow: 1700,
    });
    expect(
      resolveRate({
        ...base,
        calibration: { kind: "thin" },
        remembered: { ...remembered, planId: "claude-max" },
      }),
    ).toMatchObject({ basis: "public", usdPerWindow: 1600 });
    expect(
      resolveRate({
        ...base,
        calibration: null,
        remembered: { ...remembered, at: NOW - 30 * 24 * HOUR },
      }),
    ).toMatchObject({ basis: "public" });
  });

  it("keeps the rejected calibration visible", () => {
    expect(
      resolveRate({
        ...base,
        calibration: { kind: "outOfRange", usdPerWindow: 40, usedPercent: 50 },
      }),
    ).toEqual({ basis: "public", usdPerWindow: 1600, rejectedUsdPerWindow: 40 });
  });

  it("reports no 5-hour limit when live limits have no session window", () => {
    expect(
      resolveRate({ ...base, measure: "session", windowPresent: false, calibration: null }),
    ).toEqual({ basis: "noLimit", usdPerWindow: null });
    expect(
      resolveRate({
        ...base,
        measure: "session",
        hasLimitData: false,
        windowPresent: false,
        calibration: null,
      }),
    ).toMatchObject({ basis: "public", usdPerWindow: 280 });
  });
});

describe("limitShare", () => {
  it("converts API cost to a share of the window", () => {
    const rate = { basis: "public" as const, usdPerWindow: 1600 };
    expect(limitShare(480, rate)).toBeCloseTo(0.3);
    expect(limitShare(10, { basis: "noLimit", usdPerWindow: null })).toBeNull();
    expect(formatLimitShare(0.3)).toBe("30%");
    expect(formatLimitShare(0.034)).toBe("3.4%");
    expect(formatLimitShare(0.0004)).toBe("<0.1%");
    expect(formatLimitShare(null)).toBe("-");
  });

  it("weights models by API price within one provider", () => {
    const rate = { basis: "public" as const, usdPerWindow: 700 };
    const opus = limitShare(210, rate)!;
    const haiku = limitShare(70, rate)!;
    expect(opus / haiku).toBeCloseTo(3);
  });
});

describe("estimateProviderLimits", () => {
  const dayStart = Date.parse("2026-11-16T00:00:00.000Z");
  const daily = Array.from({ length: 7 }, (_, index) => ({
    day: new Date(dayStart + index * 24 * HOUR).toISOString().slice(0, 10),
    byProvider: costs("codex", 100),
  }));
  const hourly = Array.from({ length: 24 }, (_, index) => ({
    hourStart: new Date(NOW - (24 - index) * HOUR).toISOString(),
    byProvider: costs("codex", 2),
  }));
  const common = {
    provider: "codex" as const,
    planSetting: undefined,
    auth: { label: "ChatGPT Pro 200 Subscription" },
    daily,
    dailyCoverageStartMs: dayStart,
    hourly,
    hourlyCoverageStartMs: NOW - 24 * HOUR,
    timeZone: "UTC",
    remembered: {},
    nowMs: NOW,
  };

  it("calibrates both windows from this account's live limits", () => {
    const estimate = estimateProviderLimits({
      ...common,
      windows: [
        // Opened 2026-11-17T00:00Z: five full days plus today so far ($600) at 80% → $750.
        window({
          resetsAt: "2026-11-24T00:00:00.000Z",
          windowDurationMins: 10080,
          usedPercent: 80,
        }),
        // Opened two hours ago: $4 at 4% is thin, so the public figure stays.
        window({
          kind: "session",
          resetsAt: new Date(NOW + 3 * HOUR).toISOString(),
          windowDurationMins: 300,
          usedPercent: 4,
        }),
      ],
    });
    expect(estimate.plan.id).toBe("codex-pro-200");
    expect(estimate.planSource).toBe("detected");
    expect(estimate.rates.weekly.basis).toBe("calibrated");
    expect(estimate.rates.weekly.usdPerWindow).toBeCloseTo(750);
    expect(estimate.rates.session).toEqual({ basis: "public", usdPerWindow: 115 });
  });

  it("uses public figures without live limits or coverage", () => {
    const estimate = estimateProviderLimits({
      ...common,
      planSetting: "codex-plus",
      windows: undefined,
      dailyCoverageStartMs: null,
    });
    expect(estimate.planSource).toBe("setting");
    expect(estimate.rates.weekly).toEqual({ basis: "public", usdPerWindow: 55 });
    expect(estimate.rates.session).toEqual({ basis: "public", usdPerWindow: 7.5 });
  });

  it("remembers fresh calibrations and refreshes them at most every ten minutes", () => {
    const estimate = estimateProviderLimits({
      ...common,
      windows: [
        window({
          resetsAt: "2026-11-24T00:00:00.000Z",
          windowDurationMins: 10080,
          usedPercent: 80,
        }),
      ],
    });
    const remembered = rememberCalibrations({}, [estimate], NOW);
    expect(remembered.codex?.weekly).toMatchObject({ planId: "codex-pro-200", at: NOW });
    expect(rememberCalibrations(remembered, [estimate], NOW + 60_000)).toBe(remembered);
    expect(rememberCalibrations(remembered, [estimate], NOW + 11 * 60_000)).not.toBe(remembered);
  });
});
