// @effect-diagnostics globalDate:off -- Fixed instants keep window and bucket assertions deterministic.
import type { ServerProviderUsageWindow, UsageProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  calibrateObservation,
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
  parseRememberedCalibrations,
  REMEMBERED_MAX_AGE_MS,
  rememberCalibrations,
  rememberedApplies,
  resolvePlan,
  resolveRate,
  sessionLimitAbsenceVerified,
  SUBSCRIPTION_PLANS,
  zonedDayStartMs,
  type CostHistory,
  type LimitObservation,
} from "./usageEstimate.ts";

const HOUR = 3_600_000;
const MINUTE = 60_000;
const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const plan = (id: string) => SUBSCRIPTION_PLANS.find((entry) => entry.id === id)!;

function window(overrides: Partial<ServerProviderUsageWindow>): ServerProviderUsageWindow {
  return { id: "w", kind: "weekly", label: "Weekly", usedPercent: 0, ...overrides };
}

function costs(provider: UsageProviderKind, costUsd: number) {
  return new Map([[provider, { costUsd }]]);
}

const weeklyWindow = (usedPercent: number) =>
  window({ resetsAt: "2026-11-24T00:00:00.000Z", windowDurationMins: 10080, usedPercent });

/** $100 a day of Codex from 2026-11-16 UTC, with data read at `dataEndMs`. */
function dailyHistory(dataEndMs: number, perDay = 100): CostHistory {
  const dayStart = Date.parse("2026-11-16T00:00:00.000Z");
  return {
    periods: dailyCostPeriods(
      Array.from({ length: 7 }, (_, index) => ({
        day: new Date(dayStart + index * 24 * HOUR).toISOString().slice(0, 10),
        byProvider: costs("codex", perDay),
      })),
      "codex",
      "UTC",
    ),
    coverageStartMs: dayStart,
    dataEndMs,
  };
}

function calibratedUsd(result: ReturnType<typeof calibrateObservation>): number | null {
  return typeof result === "object" && result.kind === "calibrated" ? result.usdPerWindow : null;
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

describe("Claude Max 5x", () => {
  it("maps every Max 5x sign-in to the $100 plan and only 20x sign-ins to Ultra", () => {
    for (const auth of [
      { type: "claude_max_5x_subscription", label: "Claude Max Subscription" },
      { type: "max5", label: "Claude Max Subscription" },
      { type: "max", label: "Claude Max Subscription" },
      { type: "claude_max_subscription" },
    ]) {
      expect(detectPlan("claude", auth)).toBe("claude-max");
    }
    expect(
      detectPlan("claude", {
        type: "claude_max_20x_subscription",
        label: "Claude Ultra Subscription",
      }),
    ).toBe("claude-ultra");
    expect(detectPlan("claude", { type: "max20" })).toBe("claude-ultra");
  });

  it("has a public figure for the $100 plan and uses it when the plan is unknown", () => {
    const { plan: fallback, source } = resolvePlan("claude", undefined, null);
    expect(source).toBe("default");
    expect(fallback).toMatchObject({
      id: "claude-max",
      label: "Claude Max 5x ($100)",
      weeklyUsd: 1250,
      sessionUsd: 125,
    });
    // Still changeable by the setting.
    expect(resolvePlan("claude", "claude-ultra", "claude-max").plan.label).toBe(
      "Claude Max 20x / Ultra ($200)",
    );
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

  it("treats a reset at the reading as passed and needs a positive duration", () => {
    const resetsAt = new Date(NOW + 2 * HOUR).toISOString();
    expect(
      currentWindowStart(window({ resetsAt: new Date(NOW).toISOString() }), "weekly", NOW),
    ).toBeNull();
    expect(
      currentWindowStart(window({ resetsAt, windowDurationMins: 0 }), "weekly", NOW),
    ).toBeNull();
    // A nonstandard duration is taken as reported.
    expect(
      currentWindowStart(
        window({ kind: "session", resetsAt, windowDurationMins: 240 }),
        "session",
        NOW,
      ),
    ).toBe(NOW - 2 * HOUR);
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

  it("stops at the reading when the data runs past it", () => {
    // The open bucket holds $12 over the hour the data covers; the reading saw its first half.
    const periods = [
      { startMs: NOW - 2 * HOUR, endMs: NOW - HOUR, costUsd: 10 },
      { startMs: NOW - HOUR, endMs: NOW + 23 * HOUR, costUsd: 12 },
    ];
    expect(costSince(periods, NOW - 2 * HOUR, NOW - HOUR / 2, NOW)).toBeCloseTo(16);
    // Buckets that opened after the reading do not count.
    const later = [...periods, { startMs: NOW - HOUR / 4, endMs: NOW, costUsd: 50 }];
    expect(costSince(later, NOW - 2 * HOUR, NOW - HOUR / 2, NOW)).toBeCloseTo(16);
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

  it("gives DST transition days their real length", () => {
    // Berlin springs forward on 2026-03-29 (23 hours) and falls back on 2026-10-25 (25 hours).
    const [spring] = dailyCostPeriods(
      [{ day: "2026-03-29", byProvider: costs("claude", 23) }],
      "claude",
      "Europe/Berlin",
    );
    expect(new Date(spring!.startMs).toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(new Date(spring!.endMs).toISOString()).toBe("2026-03-29T22:00:00.000Z");
    const [autumn] = dailyCostPeriods(
      [{ day: "2026-10-25", byProvider: costs("claude", 25) }],
      "claude",
      "Europe/Berlin",
    );
    expect(new Date(autumn!.startMs).toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect((autumn!.endMs - autumn!.startMs) / HOUR).toBe(25);
    // Each real hour of the long day holds an equal $1.
    expect(
      costSince([autumn!], autumn!.startMs + 2 * HOUR, autumn!.startMs + 4 * HOUR, autumn!.endMs),
    ).toBeCloseTo(2);
    // New York springs forward on 2026-03-08.
    const [newYork] = dailyCostPeriods(
      [{ day: "2026-03-08", byProvider: costs("claude", 1) }],
      "claude",
      "America/New_York",
    );
    expect(new Date(newYork!.startMs).toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect((newYork!.endMs - newYork!.startMs) / HOUR).toBe(23);
  });
});

describe("calibrateWindow", () => {
  const base = { observedAtMs: NOW };

  it("divides API cost by the observed share", () => {
    expect(
      calibrateWindow({
        ...base,
        measure: "weekly",
        usedPercent: 25,
        costUsd: 400,
        publicUsd: 1600,
      }),
    ).toEqual({ kind: "calibrated", usdPerWindow: 1600, usedPercent: 25, observedAtMs: NOW });
  });

  it("refuses thin windows", () => {
    expect(
      calibrateWindow({
        ...base,
        measure: "weekly",
        usedPercent: 3,
        costUsd: 400,
        publicUsd: 1600,
      }),
    ).toEqual({ kind: "thin" });
    expect(
      calibrateWindow({
        ...base,
        measure: "session",
        usedPercent: 40,
        costUsd: 0.5,
        publicUsd: 280,
      }),
    ).toEqual({ kind: "thin" });
  });

  it("flags results far from the public figure", () => {
    expect(
      calibrateWindow({
        ...base,
        measure: "weekly",
        usedPercent: 50,
        costUsd: 20,
        publicUsd: 1600,
      }),
    ).toMatchObject({ kind: "outOfRange", usdPerWindow: 40 });
  });
});

describe("calibrateObservation", () => {
  const observation = (overrides: Partial<LimitObservation> = {}): LimitObservation => ({
    windows: [weeklyWindow(80)],
    checkedAtMs: NOW,
    probeFailed: false,
    ...overrides,
  });
  const base = { measure: "weekly" as const, window: weeklyWindow(80), publicUsd: 700 };

  it("counts cost only up to the reading's own time", () => {
    // Opened 2026-11-17T00:00Z. The data runs 5 minutes past the 12:00 reading, so today's $100
    // spreads over 12h05m and 12h of it predate the reading.
    const result = calibrateObservation({
      ...base,
      observation: observation(),
      costs: [dailyHistory(NOW + 5 * MINUTE)],
      nowMs: NOW + 5 * MINUTE,
    });
    expect(result).toMatchObject({ kind: "calibrated", observedAtMs: NOW });
    expect(calibratedUsd(result)).toBeCloseTo((500 + (100 * 12) / (12 + 5 / 60)) / 0.8);
  });

  it("rejects a retained reading after a failed probe even as costs advance", () => {
    for (const nowMs of [NOW, NOW + 3 * 24 * HOUR]) {
      expect(
        calibrateObservation({
          ...base,
          window: weeklyWindow(20),
          observation: observation({ probeFailed: true }),
          costs: [dailyHistory(nowMs)],
          nowMs,
        }),
      ).toBe("probeFailed");
    }
  });

  it("rejects stale, future and unreadable reading times", () => {
    const costsNow = [dailyHistory(NOW)];
    for (const checkedAtMs of [NOW - 16 * MINUTE, NOW + 3 * MINUTE, Number.NaN]) {
      expect(
        calibrateObservation({
          ...base,
          observation: observation({ checkedAtMs }),
          costs: costsNow,
          nowMs: NOW,
        }),
      ).toBe("stale");
    }
  });

  it("refuses cost data that ends before the reading or runs far past it", () => {
    const common = { ...base, observation: observation(), nowMs: NOW };
    expect(calibrateObservation({ ...common, costs: [dailyHistory(NOW - 10 * MINUTE)] })).toBe(
      "incomplete",
    );
    expect(calibrateObservation({ ...common, costs: [dailyHistory(NOW + 20 * MINUTE)] })).toBe(
      "incomplete",
    );
  });

  it("lets usable daily history win over unsettled or too-short hourly history", () => {
    const common = { ...base, observation: observation(), nowMs: NOW };
    const shortHourly: CostHistory = {
      periods: [],
      coverageStartMs: NOW - 24 * HOUR,
      dataEndMs: NOW,
    };
    expect(
      calibrateObservation({ ...common, costs: ["incomplete", dailyHistory(NOW)] }),
    ).toMatchObject({ kind: "calibrated" });
    expect(
      calibrateObservation({ ...common, costs: [shortHourly, dailyHistory(NOW)] }),
    ).toMatchObject({ kind: "calibrated" });
    expect(calibrateObservation({ ...common, costs: ["otherAccounts", "incomplete"] })).toBe(
      "otherAccounts",
    );
    expect(calibrateObservation({ ...common, costs: ["incomplete", "otherAccounts"] })).toBe(
      "otherAccounts",
    );
  });
});

describe("sessionLimitAbsenceVerified", () => {
  const weeklyOnly: LimitObservation = {
    windows: [weeklyWindow(30)],
    checkedAtMs: NOW,
    probeFailed: false,
  };

  it("accepts a current, complete weekly-only reading of a Codex Pro plan", () => {
    expect(sessionLimitAbsenceVerified("codex-pro-100", weeklyOnly, NOW)).toBe(true);
  });

  it("does not take missing data as proof", () => {
    // Plans that keep a 5-hour window, or no detected plan.
    expect(sessionLimitAbsenceVerified("codex-plus", weeklyOnly, NOW)).toBe(false);
    expect(sessionLimitAbsenceVerified("claude-ultra", weeklyOnly, NOW)).toBe(false);
    expect(sessionLimitAbsenceVerified(null, weeklyOnly, NOW)).toBe(false);
    // Failed, old or missing readings.
    expect(
      sessionLimitAbsenceVerified("codex-pro-100", { ...weeklyOnly, probeFailed: true }, NOW),
    ).toBe(false);
    expect(sessionLimitAbsenceVerified("codex-pro-100", weeklyOnly, NOW + 25 * HOUR)).toBe(false);
    expect(sessionLimitAbsenceVerified("codex-pro-100", undefined, NOW)).toBe(false);
    // Only a model-scoped weekly pool.
    const scopedOnly = { ...weeklyOnly, windows: [window({ id: "m", modelIds: ["gpt-5"] })] };
    expect(sessionLimitAbsenceVerified("codex-pro-100", scopedOnly, NOW)).toBe(false);
    // A scoped 5-hour window still means 5-hour limits exist.
    const scopedSession = {
      ...weeklyOnly,
      windows: [weeklyWindow(30), window({ id: "s", kind: "session", modelIds: ["gpt-5"] })],
    };
    expect(sessionLimitAbsenceVerified("codex-pro-100", scopedSession, NOW)).toBe(false);
  });
});

describe("resolveRate", () => {
  const remembered = {
    usdPerWindow: 1700,
    usedPercent: 40,
    at: NOW - HOUR,
    planId: "claude-ultra",
    account: "email:claude:a",
  };
  const base = {
    measure: "weekly" as const,
    plan: plan("claude-ultra"),
    verifiedNoLimit: false,
    windowUnreported: false,
    remembered: undefined,
    account: "email:claude:a",
    nowMs: NOW,
  };

  it("falls back from calibrated to remembered to public", () => {
    expect(
      resolveRate({
        ...base,
        calibration: { kind: "calibrated", usdPerWindow: 1800, usedPercent: 20, observedAtMs: NOW },
      }),
    ).toMatchObject({ basis: "calibrated", usdPerWindow: 1800, observedAtMs: NOW });
    expect(resolveRate({ ...base, calibration: { kind: "thin" }, remembered })).toMatchObject({
      basis: "remembered",
      usdPerWindow: 1700,
      blocked: "thin",
    });
    expect(
      resolveRate({
        ...base,
        calibration: { kind: "thin" },
        remembered: { ...remembered, planId: "claude-max" },
      }),
    ).toMatchObject({ basis: "public", usdPerWindow: 1600 });
  });

  it("uses remembered figures only for the same account", () => {
    expect(
      resolveRate({ ...base, calibration: "stale", remembered, account: "email:claude:b" }),
    ).toMatchObject({ basis: "public", blocked: "stale" });
    expect(
      resolveRate({ ...base, calibration: "mixedAccounts", remembered, account: null }),
    ).toMatchObject({ basis: "public", blocked: "mixedAccounts" });
  });

  it("keeps the rejected calibration visible", () => {
    expect(
      resolveRate({
        ...base,
        calibration: { kind: "outOfRange", usdPerWindow: 40, usedPercent: 50 },
      }),
    ).toEqual({ basis: "public", usdPerWindow: 1600, rejectedUsdPerWindow: 40 });
  });

  it("reports no limit only when verified, and unknown when no figure exists", () => {
    expect(
      resolveRate({ ...base, measure: "session", verifiedNoLimit: true, calibration: null }),
    ).toEqual({ basis: "noLimit", usdPerWindow: null });
    expect(
      resolveRate({
        ...base,
        measure: "session",
        windowUnreported: true,
        calibration: "noReading",
      }),
    ).toEqual({ basis: "public", usdPerWindow: 280, windowUnreported: true, blocked: "noReading" });
    expect(
      resolveRate({
        ...base,
        measure: "session",
        plan: { ...plan("claude-ultra"), sessionUsd: null },
        windowUnreported: true,
        calibration: "noReading",
      }),
    ).toMatchObject({ basis: "unknown", usdPerWindow: null, windowUnreported: true });
  });
});

describe("remembered calibrations", () => {
  const entry = {
    usdPerWindow: 700,
    usedPercent: 40,
    at: NOW - HOUR,
    planId: "codex-pro-200",
    account: "email:codex:a",
  };
  const applies = (overrides: Partial<typeof entry>, account: string | null = entry.account) =>
    rememberedApplies({ ...entry, ...overrides }, account, "codex-pro-200", NOW);

  it("applies for 21 days and never with a future timestamp", () => {
    expect(applies({})).toBe(true);
    expect(applies({ at: NOW })).toBe(true);
    expect(applies({ at: NOW - REMEMBERED_MAX_AGE_MS })).toBe(true);
    expect(applies({ at: NOW - REMEMBERED_MAX_AGE_MS - 1 })).toBe(false);
    expect(applies({ at: NOW + 1 })).toBe(false);
    expect(applies({}, "email:codex:b")).toBe(false);
    expect(applies({}, null)).toBe(false);
    expect(applies({ planId: "codex-pro-100" })).toBe(false);
  });

  it("drops malformed stored entries one by one", () => {
    expect(
      parseRememberedCalibrations({
        codex: { weekly: entry, session: { ...entry, usdPerWindow: 0 } },
        claude: {
          weekly: { ...entry, usdPerWindow: -5 },
          session: { ...entry, account: undefined },
        },
      }),
    ).toEqual({ codex: { weekly: entry } });
    for (const bad of [
      { usdPerWindow: Number.POSITIVE_INFINITY },
      { usdPerWindow: "700" },
      { usedPercent: 0 },
      { usedPercent: 140 },
      { at: Number.NaN },
      { planId: "" },
    ]) {
      expect(parseRememberedCalibrations({ codex: { weekly: { ...entry, ...bad } } })).toEqual({});
    }
    expect(parseRememberedCalibrations(null)).toEqual({});
    expect(parseRememberedCalibrations("garbage")).toEqual({});
    expect(parseRememberedCalibrations({ codex: 3 })).toEqual({});
  });
});

describe("limitShare", () => {
  it("converts API cost to a share of the window", () => {
    const rate = { basis: "public" as const, usdPerWindow: 1600 };
    expect(limitShare(480, rate)).toBeCloseTo(0.3);
    expect(limitShare(10, { basis: "noLimit", usdPerWindow: null })).toBeNull();
    expect(limitShare(10, { basis: "unknown", usdPerWindow: null })).toBeNull();
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
  const hourly: CostHistory = {
    periods: hourlyCostPeriods(
      Array.from({ length: 24 }, (_, index) => ({
        hourStart: new Date(NOW - (24 - index) * HOUR).toISOString(),
        byProvider: costs("codex", 2),
      })),
      "codex",
    ),
    coverageStartMs: NOW - 24 * HOUR,
    dataEndMs: NOW,
  };
  const common = {
    provider: "codex" as const,
    planSetting: undefined,
    auth: { label: "ChatGPT Pro 200 Subscription" },
    account: "email:codex:a",
    costs: { hourly, daily: dailyHistory(NOW) },
    remembered: {},
    nowMs: NOW,
  };
  const observation = (windows: LimitObservation["windows"]): LimitObservation => ({
    windows,
    checkedAtMs: NOW,
    probeFailed: false,
  });

  it("calibrates both windows from this account's live limits", () => {
    const estimate = estimateProviderLimits({
      ...common,
      observation: observation([
        // Opened 2026-11-17T00:00Z: five full days plus today so far ($600) at 80% → $750.
        weeklyWindow(80),
        // Opened two hours ago: $4 at 4% is thin, so the public figure stays.
        window({
          kind: "session",
          resetsAt: new Date(NOW + 3 * HOUR).toISOString(),
          windowDurationMins: 300,
          usedPercent: 4,
        }),
      ]),
    });
    expect(estimate.plan.id).toBe("codex-pro-200");
    expect(estimate.planSource).toBe("detected");
    expect(estimate.account).toBe("email:codex:a");
    expect(estimate.rates.weekly.basis).toBe("calibrated");
    // Hourly reaches back only 24 hours, so the weekly window uses daily history.
    expect(estimate.rates.weekly.usdPerWindow).toBeCloseTo(750);
    expect(estimate.rates.session).toEqual({ basis: "public", usdPerWindow: 115, blocked: "thin" });
  });

  it("uses public figures without live limits", () => {
    const estimate = estimateProviderLimits({
      ...common,
      planSetting: "codex-plus",
      observation: undefined,
    });
    expect(estimate.planSource).toBe("setting");
    expect(estimate.rates.weekly).toEqual({
      basis: "public",
      usdPerWindow: 55,
      blocked: "noReading",
    });
    expect(estimate.rates.session).toEqual({
      basis: "public",
      usdPerWindow: 7.5,
      blocked: "noReading",
    });
  });

  it("shows no 5-hour limit for a verified weekly-only Codex Pro reading", () => {
    const estimate = estimateProviderLimits({
      ...common,
      auth: { label: "ChatGPT Pro 100 Subscription" },
      observation: observation([weeklyWindow(30)]),
    });
    expect(estimate.rates.session).toEqual({ basis: "noLimit", usdPerWindow: null });
  });

  it("falls back to an estimate when the 5-hour window is merely missing", () => {
    // Plus keeps a 5-hour limit, so its absence from the reading proves nothing.
    const plus = estimateProviderLimits({
      ...common,
      auth: { label: "ChatGPT Plus Subscription" },
      observation: observation([weeklyWindow(30)]),
    });
    expect(plus.rates.session).toMatchObject({ basis: "public", windowUnreported: true });
    // A failed probe with retained windows is not a complete reading.
    const failed = estimateProviderLimits({
      ...common,
      auth: { label: "ChatGPT Pro 100 Subscription" },
      observation: { ...observation([weeklyWindow(30)]), probeFailed: true },
    });
    expect(failed.rates.session).toMatchObject({ basis: "public", blocked: "probeFailed" });
    expect(failed.rates.session.windowUnreported).toBeUndefined();
    expect(failed.rates.weekly).toMatchObject({ basis: "public", blocked: "probeFailed" });
  });

  it("does not calibrate or use remembered figures across mixed accounts", () => {
    const estimate = estimateProviderLimits({
      ...common,
      account: null,
      costs: { blocked: "mixedAccounts" },
      remembered: {
        codex: {
          weekly: {
            usdPerWindow: 600,
            usedPercent: 50,
            at: NOW - HOUR,
            planId: "codex-pro-200",
            account: "email:codex:a",
          },
        },
      },
      observation: observation([weeklyWindow(80)]),
    });
    expect(estimate.rates.weekly).toMatchObject({ basis: "public", blocked: "mixedAccounts" });
  });

  it("remembers a calibration under its account and reading time", () => {
    const estimate = estimateProviderLimits({
      ...common,
      observation: observation([weeklyWindow(80)]),
    });
    // Saved later, it keeps the reading's time rather than the save time.
    const remembered = rememberCalibrations({}, [estimate], NOW + 5 * MINUTE);
    expect(remembered.codex?.weekly).toMatchObject({
      planId: "codex-pro-200",
      account: "email:codex:a",
      at: NOW,
    });
    // The same reading again changes nothing.
    expect(rememberCalibrations(remembered, [estimate], NOW + 20 * MINUTE)).toBe(remembered);
    // A newer reading replaces it.
    const newer = estimateProviderLimits({
      ...common,
      nowMs: NOW + HOUR,
      costs: { hourly: "incomplete", daily: dailyHistory(NOW + HOUR) },
      observation: { ...observation([weeklyWindow(85)]), checkedAtMs: NOW + HOUR },
    });
    expect(rememberCalibrations(remembered, [newer], NOW + HOUR).codex?.weekly?.at).toBe(
      NOW + HOUR,
    );
    // Another account replaces it even with an older reading.
    const other = { ...estimate, account: "email:codex:b" };
    expect(rememberCalibrations(remembered, [other], NOW).codex?.weekly?.account).toBe(
      "email:codex:b",
    );
    // An estimate without an account identity is never stored.
    expect(rememberCalibrations({}, [{ ...estimate, account: null }], NOW)).toEqual({});
  });

  it("never stamps a reading with a time later than now", () => {
    const estimate = estimateProviderLimits({
      ...common,
      observation: { ...observation([weeklyWindow(80)]), checkedAtMs: NOW + MINUTE },
    });
    expect(rememberCalibrations({}, [estimate], NOW).codex?.weekly?.at).toBe(NOW);
  });
});
