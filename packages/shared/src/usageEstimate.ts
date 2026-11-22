// @effect-diagnostics globalDate:off -- Limit windows and usage days are wall-clock instants bucketed via Intl.
/**
 * Limits are published only as percentages, so a share is API cost divided by the cost of a full
 * window: calibrated from this account's open window, remembered, or a public per-plan figure.
 * Models weigh by API price; providers publish no per-model weights for the shared pools.
 */
import type { ServerProviderUsageWindow, UsageProviderKind } from "@t3tools/contracts";

export const ESTIMATE_PROVIDERS = ["claude", "codex"] as const;
export type EstimateProvider = (typeof ESTIMATE_PROVIDERS)[number];
export type LimitMeasure = "weekly" | "session";

export interface SubscriptionPlan {
  readonly id: string;
  readonly provider: EstimateProvider;
  readonly label: string;
  /** API-priced USD that fills 100% of the weekly window. */
  readonly weeklyUsd: number;
  /** API-priced USD that fills 100% of the 5-hour window; null when the plan has none. */
  readonly sessionUsd: number | null;
}

/**
 * Third-party measurements read 2026-11-22: wokey.ai/claude-usage-limits, wokey.ai/codex-usage-limits,
 * mulletiq.com/blog/claude-max-20x-vs-5x, inventivehq.com/blog/codex-subscription-usage-measured.
 * Codex Pro 5-hour figures are weekly / 6, Plus's measured ratio.
 */
export const SUBSCRIPTION_PLANS: readonly SubscriptionPlan[] = [
  { id: "claude-pro", provider: "claude", label: "Claude Pro", weeklyUsd: 165, sessionUsd: 13 },
  { id: "claude-max", provider: "claude", label: "Claude Max", weeklyUsd: 1250, sessionUsd: 125 },
  {
    id: "claude-ultra",
    provider: "claude",
    label: "Claude Ultra (Max 20x)",
    weeklyUsd: 1600,
    sessionUsd: 280,
  },
  { id: "codex-plus", provider: "codex", label: "ChatGPT Plus", weeklyUsd: 55, sessionUsd: 7.5 },
  {
    id: "codex-pro-100",
    provider: "codex",
    label: "ChatGPT Pro 100",
    weeklyUsd: 350,
    sessionUsd: 58,
  },
  {
    id: "codex-pro-200",
    provider: "codex",
    label: "ChatGPT Pro 200",
    weeklyUsd: 700,
    sessionUsd: 115,
  },
  {
    id: "codex-pro-500",
    provider: "codex",
    label: "ChatGPT Pro 500",
    weeklyUsd: 1650,
    sessionUsd: 275,
  },
];

const DEFAULT_PLAN: Record<EstimateProvider, string> = {
  claude: "claude-max",
  codex: "codex-plus",
};

export function plansFor(provider: EstimateProvider): readonly SubscriptionPlan[] {
  return SUBSCRIPTION_PLANS.filter((plan) => plan.provider === provider);
}

function planById(provider: EstimateProvider, id: string | null | undefined) {
  return id
    ? SUBSCRIPTION_PLANS.find((plan) => plan.id === id && plan.provider === provider)
    : undefined;
}

const normalize = (value: string | undefined) =>
  (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Reads the plan from the provider's auth type and label, or null when it is not a known plan. */
export function detectPlan(
  provider: EstimateProvider,
  auth: { readonly type?: string | undefined; readonly label?: string | undefined } | undefined,
): string | null {
  const text = `${normalize(auth?.type)} ${normalize(auth?.label)}`;
  if (text.includes("apikey") || text.includes("bedrock")) return null;
  if (provider === "claude") {
    if (text.includes("ultra") || text.includes("max20")) return "claude-ultra";
    if (text.includes("max")) return "claude-max";
    if (text.includes("pro")) return "claude-pro";
    return null;
  }
  if (text.includes("pro500")) return "codex-pro-500";
  if (text.includes("pro200")) return "codex-pro-200";
  if (text.includes("pro100") || text.includes("businesspremium")) return "codex-pro-100";
  if (text.includes("plus") || text.includes("business")) return "codex-plus";
  return null;
}

export type PlanSource = "setting" | "detected" | "default";

export function resolvePlan(
  provider: EstimateProvider,
  setting: string | undefined,
  detected: string | null,
): { readonly plan: SubscriptionPlan; readonly source: PlanSource } {
  const chosen = planById(provider, setting);
  if (chosen) return { plan: chosen, source: "setting" };
  const found = planById(provider, detected);
  if (found) return { plan: found, source: "detected" };
  return { plan: planById(provider, DEFAULT_PLAN[provider])!, source: "default" };
}

const DEFAULT_WINDOW_MINS: Record<LimitMeasure, number> = { session: 300, weekly: 7 * 24 * 60 };

/** The provider-wide window for a measure; model-scoped pools do not limit everything. */
export function mainLimitWindow(
  windows: readonly ServerProviderUsageWindow[],
  measure: LimitMeasure,
): ServerProviderUsageWindow | undefined {
  return windows.find(
    (window) =>
      window.kind === measure &&
      (window.modelIds?.length ?? 0) === 0 &&
      (window.providerIds?.length ?? 0) === 0,
  );
}

/** Start of the window that is current at `nowMs`, or null without a future reset time. */
export function currentWindowStart(
  window: ServerProviderUsageWindow,
  measure: LimitMeasure,
  nowMs: number,
): number | null {
  if (window.resetsAt === undefined) return null;
  const resetsAtMs = Date.parse(window.resetsAt);
  if (!Number.isFinite(resetsAtMs) || resetsAtMs <= nowMs) return null;
  const durationMs = (window.windowDurationMins ?? DEFAULT_WINDOW_MINS[measure]) * 60_000;
  return resetsAtMs - durationMs;
}

export interface CostPeriod {
  readonly startMs: number;
  readonly endMs: number;
  readonly costUsd: number;
}

/**
 * Cost from `sinceMs` to `nowMs`, assuming each bucket's cost is spread evenly
 * over its period. The current period ends at `nowMs`, since nothing after now
 * has happened yet.
 */
export function costSince(periods: readonly CostPeriod[], sinceMs: number, nowMs: number): number {
  let total = 0;
  for (const period of periods) {
    if (period.startMs > nowMs) continue;
    const end = Math.min(period.endMs, nowMs);
    const length = end - period.startMs;
    if (length <= 0) {
      // A period that opened this instant holds only work recorded right now.
      if (period.startMs >= sinceMs) total += period.costUsd;
      continue;
    }
    const overlap = end - Math.max(period.startMs, sinceMs);
    if (overlap > 0) total += period.costUsd * (overlap / length);
  }
  return total;
}

function timeZoneOffsetMs(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instantMs));
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour"),
    value("minute"),
    value("second"),
  );
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** Midnight of a YYYY-MM-DD day in an IANA time zone, as epoch milliseconds. */
export function zonedDayStartMs(day: string, timeZone: string): number {
  const [year = 1970, month = 1, date = 1] = day.split("-").map(Number);
  const guess = Date.UTC(year, month - 1, date);
  let start = guess - timeZoneOffsetMs(guess, timeZone);
  // A second pass settles days whose offset changes between the guess and midnight.
  start = guess - timeZoneOffsetMs(start, timeZone);
  return start;
}

function addDay(day: string): string {
  const [year = 1970, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10);
}

export function dailyCostPeriods(
  daily: readonly {
    readonly day: string;
    readonly byProvider: ReadonlyMap<UsageProviderKind, { readonly costUsd: number }>;
  }[],
  provider: UsageProviderKind,
  timeZone: string,
): readonly CostPeriod[] {
  return daily.map((entry) => ({
    startMs: zonedDayStartMs(entry.day, timeZone),
    endMs: zonedDayStartMs(addDay(entry.day), timeZone),
    costUsd: entry.byProvider.get(provider)?.costUsd ?? 0,
  }));
}

export function hourlyCostPeriods(
  hourly: readonly {
    readonly hourStart: string;
    readonly byProvider: ReadonlyMap<UsageProviderKind, { readonly costUsd: number }>;
  }[],
  provider: UsageProviderKind,
): readonly CostPeriod[] {
  return hourly.map((entry) => {
    const startMs = Date.parse(entry.hourStart);
    return {
      startMs,
      endMs: startMs + 3_600_000,
      costUsd: entry.byProvider.get(provider)?.costUsd ?? 0,
    };
  });
}

/** Below these, one request's rounding dominates the observed percentage. */
const MIN_USED_PERCENT: Record<LimitMeasure, number> = { weekly: 5, session: 10 };
const MIN_COST_USD: Record<LimitMeasure, number> = { weekly: 5, session: 1 };
/** Calibrations this far from the public figure usually mean usage outside these transcripts. */
const MAX_DEVIATION = 4;

export type Calibration =
  | { readonly kind: "calibrated"; readonly usdPerWindow: number; readonly usedPercent: number }
  | { readonly kind: "thin" }
  | { readonly kind: "outOfRange"; readonly usdPerWindow: number; readonly usedPercent: number };

export function calibrateWindow(input: {
  readonly measure: LimitMeasure;
  readonly usedPercent: number;
  readonly costUsd: number;
  readonly publicUsd: number | null;
}): Calibration {
  const { measure, usedPercent, costUsd, publicUsd } = input;
  if (usedPercent < MIN_USED_PERCENT[measure] || costUsd < MIN_COST_USD[measure]) {
    return { kind: "thin" };
  }
  const usdPerWindow = costUsd / (usedPercent / 100);
  if (
    publicUsd !== null &&
    (usdPerWindow > publicUsd * MAX_DEVIATION || usdPerWindow < publicUsd / MAX_DEVIATION)
  ) {
    return { kind: "outOfRange", usdPerWindow, usedPercent };
  }
  return { kind: "calibrated", usdPerWindow, usedPercent };
}

export interface RememberedCalibration {
  readonly usdPerWindow: number;
  readonly usedPercent: number;
  readonly at: number;
  readonly planId: string;
}

/** Remembered calibrations older than this predate most plan and pricing changes. */
const REMEMBERED_MAX_AGE_MS = 21 * 24 * 3_600_000;

export type RateBasis = "calibrated" | "remembered" | "public" | "noLimit";

export interface LimitRate {
  readonly basis: RateBasis;
  /** API-priced USD per 100% of the window; null when the account has no such limit. */
  readonly usdPerWindow: number | null;
  readonly usedPercent?: number;
  /** Set when this window's own data disagreed too much with the public figure to trust. */
  readonly rejectedUsdPerWindow?: number;
}

export function resolveRate(input: {
  readonly measure: LimitMeasure;
  readonly plan: SubscriptionPlan;
  /** Whether a live limits snapshot was read; then a missing window means no such limit. */
  readonly hasLimitData: boolean;
  readonly windowPresent: boolean;
  readonly calibration: Calibration | null;
  readonly remembered: RememberedCalibration | undefined;
  readonly nowMs: number;
}): LimitRate {
  const { measure, plan, calibration, remembered, nowMs } = input;
  if (input.hasLimitData && !input.windowPresent && measure === "session") {
    return { basis: "noLimit", usdPerWindow: null };
  }
  if (calibration?.kind === "calibrated") {
    return {
      basis: "calibrated",
      usdPerWindow: calibration.usdPerWindow,
      usedPercent: calibration.usedPercent,
    };
  }
  const rejected =
    calibration?.kind === "outOfRange" ? { rejectedUsdPerWindow: calibration.usdPerWindow } : {};
  if (
    remembered !== undefined &&
    remembered.planId === plan.id &&
    nowMs - remembered.at <= REMEMBERED_MAX_AGE_MS
  ) {
    return {
      basis: "remembered",
      usdPerWindow: remembered.usdPerWindow,
      usedPercent: remembered.usedPercent,
      ...rejected,
    };
  }
  const publicUsd = measure === "weekly" ? plan.weeklyUsd : plan.sessionUsd;
  return publicUsd === null
    ? { basis: "noLimit", usdPerWindow: null }
    : { basis: "public", usdPerWindow: publicUsd, ...rejected };
}

/** Share of a window (1 = 100%) that `costUsd` of API-priced usage fills. */
export function limitShare(costUsd: number, rate: LimitRate | undefined): number | null {
  if (rate === undefined || rate.usdPerWindow === null || rate.usdPerWindow <= 0) return null;
  return costUsd / rate.usdPerWindow;
}

export function formatLimitShare(share: number | null): string {
  if (share === null) return "-";
  const percent = share * 100;
  if (percent > 0 && percent < 0.1) return "<0.1%";
  return `${percent.toFixed(percent >= 10 ? 0 : 1)}%`;
}

export const LIMIT_MEASURE_LABEL: Record<LimitMeasure, string> = {
  weekly: "weekly",
  session: "5-hour",
};

type ProviderCostByPeriod = ReadonlyMap<UsageProviderKind, { readonly costUsd: number }>;

export interface ProviderLimitEstimate {
  readonly provider: EstimateProvider;
  readonly plan: SubscriptionPlan;
  readonly planSource: PlanSource;
  readonly detectedPlanId: string | null;
  readonly rates: Readonly<Record<LimitMeasure, LimitRate>>;
}

export type RememberedCalibrations = {
  readonly [P in EstimateProvider]?:
    | { readonly [M in LimitMeasure]?: RememberedCalibration | undefined }
    | undefined;
};

/**
 * Builds one provider's rates. `daily` must reach back past the weekly window's
 * start and `hourly` must cover the last five hours for those windows to
 * calibrate; otherwise they fall back to a remembered or public figure.
 */
export function estimateProviderLimits(input: {
  readonly provider: EstimateProvider;
  readonly planSetting: string | undefined;
  readonly auth:
    | { readonly type?: string | undefined; readonly label?: string | undefined }
    | undefined;
  /** Live limit windows, or undefined when the provider reported none. */
  readonly windows: readonly ServerProviderUsageWindow[] | undefined;
  readonly daily: readonly { readonly day: string; readonly byProvider: ProviderCostByPeriod }[];
  readonly dailyCoverageStartMs: number | null;
  readonly hourly: readonly {
    readonly hourStart: string;
    readonly byProvider: ProviderCostByPeriod;
  }[];
  readonly hourlyCoverageStartMs: number | null;
  readonly timeZone: string;
  readonly remembered: RememberedCalibrations;
  readonly nowMs: number;
}): ProviderLimitEstimate {
  const { provider, windows, nowMs } = input;
  const detectedPlanId = detectPlan(provider, input.auth);
  const { plan, source } = resolvePlan(provider, input.planSetting, detectedPlanId);
  const hasLimitData = windows !== undefined && windows.length > 0;

  const rateFor = (measure: LimitMeasure): LimitRate => {
    const window = windows === undefined ? undefined : mainLimitWindow(windows, measure);
    let calibration: Calibration | null = null;
    const startMs = window === undefined ? null : currentWindowStart(window, measure, nowMs);
    if (window !== undefined && startMs !== null) {
      const useHourly =
        input.hourlyCoverageStartMs !== null && input.hourlyCoverageStartMs <= startMs;
      const covered =
        useHourly || (input.dailyCoverageStartMs !== null && input.dailyCoverageStartMs <= startMs);
      if (covered) {
        const periods = useHourly
          ? hourlyCostPeriods(input.hourly, provider)
          : dailyCostPeriods(input.daily, provider, input.timeZone);
        calibration = calibrateWindow({
          measure,
          usedPercent: window.usedPercent,
          costUsd: costSince(periods, startMs, nowMs),
          publicUsd: measure === "weekly" ? plan.weeklyUsd : plan.sessionUsd,
        });
      }
    }
    return resolveRate({
      measure,
      plan,
      hasLimitData,
      windowPresent: window !== undefined,
      calibration,
      remembered: input.remembered[provider]?.[measure],
      nowMs,
    });
  };

  return {
    provider,
    plan,
    planSource: source,
    detectedPlanId,
    rates: { weekly: rateFor("weekly"), session: rateFor("session") },
  };
}

const REMEMBER_INTERVAL_MS = 10 * 60_000;

/** Keeps each fresh calibration so the next window can use it before it has enough data. */
export function rememberCalibrations(
  previous: RememberedCalibrations,
  estimates: readonly ProviderLimitEstimate[],
  nowMs: number,
): RememberedCalibrations {
  const next: Record<string, Record<string, RememberedCalibration | undefined>> = {};
  let changed = false;
  for (const estimate of estimates) {
    for (const measure of ["weekly", "session"] as const) {
      const rate = estimate.rates[measure];
      if (rate.basis !== "calibrated" || rate.usdPerWindow === null) continue;
      const current = previous[estimate.provider]?.[measure];
      if (
        current !== undefined &&
        current.planId === estimate.plan.id &&
        nowMs - current.at < REMEMBER_INTERVAL_MS
      ) {
        continue;
      }
      const forProvider = (next[estimate.provider] ??= { ...previous[estimate.provider] });
      forProvider[measure] = {
        usdPerWindow: rate.usdPerWindow,
        usedPercent: rate.usedPercent ?? 0,
        at: nowMs,
        planId: estimate.plan.id,
      };
      changed = true;
    }
  }
  return changed ? { ...previous, ...next } : previous;
}
