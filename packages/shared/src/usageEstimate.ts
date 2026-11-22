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
  /** API-priced USD that fills 100% of the 5-hour window; null when no figure is known. */
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

/** Plans whose complete live reading carries only a weekly window when they have no 5-hour limit. */
const WEEKLY_ONLY_PLANS: ReadonlySet<string> = new Set([
  "codex-pro-100",
  "codex-pro-200",
  "codex-pro-500",
]);

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

/**
 * Start of the window that was open at `atMs`, or null without a reset after that instant or
 * without a positive duration.
 */
export function currentWindowStart(
  window: ServerProviderUsageWindow,
  measure: LimitMeasure,
  atMs: number,
): number | null {
  if (window.resetsAt === undefined) return null;
  const resetsAtMs = Date.parse(window.resetsAt);
  if (!Number.isFinite(resetsAtMs) || resetsAtMs <= atMs) return null;
  const durationMins = window.windowDurationMins ?? DEFAULT_WINDOW_MINS[measure];
  if (!(durationMins > 0)) return null;
  return resetsAtMs - durationMins * 60_000;
}

export interface CostPeriod {
  readonly startMs: number;
  readonly endMs: number;
  readonly costUsd: number;
}

/**
 * Cost from `sinceMs` to `untilMs`, assuming each bucket's cost is spread evenly over the part
 * of its period that the data covers, which ends at `dataEndMs` for the bucket still open.
 */
export function costSince(
  periods: readonly CostPeriod[],
  sinceMs: number,
  untilMs: number,
  dataEndMs: number = untilMs,
): number {
  let total = 0;
  for (const period of periods) {
    if (period.startMs > untilMs) continue;
    const end = Math.min(period.endMs, dataEndMs);
    const length = end - period.startMs;
    if (length <= 0) {
      // A period that opened as the data was read holds only work recorded at that instant.
      if (period.startMs >= sinceMs) total += period.costUsd;
      continue;
    }
    const overlap = Math.min(end, untilMs) - Math.max(period.startMs, sinceMs);
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

/** A live percentage is a reading of one instant; older readings no longer match today's cost. */
const MAX_OBSERVATION_AGE_MS = 15 * 60_000;
/** Server and browser clocks, and a query window cut at the minute, may differ by this much. */
const CLOCK_TOLERANCE_MS = 2 * 60_000;
/** Which windows an account has changes far more slowly than how full they are. */
const STRUCTURE_MAX_AGE_MS = 24 * 3_600_000;

/** One live limits reading of one account. */
export interface LimitObservation {
  readonly windows: readonly ServerProviderUsageWindow[];
  /** When the windows were read. */
  readonly checkedAtMs: number;
  /** The last probe failed, so the windows are an older retained reading. */
  readonly probeFailed: boolean;
}

/** API cost history of the observed account, already checked for complete coverage. */
export interface CostHistory {
  readonly periods: readonly CostPeriod[];
  readonly coverageStartMs: number;
  /** The data runs through this instant. */
  readonly dataEndMs: number;
}

/** Why a live reading did not calibrate. */
export type CalibrationBlock =
  | "noReading"
  | "probeFailed"
  | "stale"
  | "noReset"
  | "incomplete"
  | "otherAccounts"
  | "mixedAccounts"
  | "thin";

export type Calibration =
  | {
      readonly kind: "calibrated";
      readonly usdPerWindow: number;
      readonly usedPercent: number;
      readonly observedAtMs: number;
    }
  | { readonly kind: "thin" }
  | { readonly kind: "outOfRange"; readonly usdPerWindow: number; readonly usedPercent: number };

export function calibrateWindow(input: {
  readonly measure: LimitMeasure;
  readonly usedPercent: number;
  readonly costUsd: number;
  readonly publicUsd: number | null;
  readonly observedAtMs: number;
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
  return { kind: "calibrated", usdPerWindow, usedPercent, observedAtMs: input.observedAtMs };
}

/**
 * Calibrates one window when the reading is current and successful and a cost history covers
 * the window up to the reading. Cost counts only through the reading's own time.
 */
export function calibrateObservation(input: {
  readonly measure: LimitMeasure;
  readonly observation: LimitObservation;
  readonly window: ServerProviderUsageWindow;
  /** Preferred first; an entry is either complete history or why it is not usable. */
  readonly costs: readonly (CostHistory | CalibrationBlock)[];
  readonly publicUsd: number | null;
  readonly nowMs: number;
}): Calibration | CalibrationBlock {
  const { measure, observation, window, nowMs } = input;
  if (observation.probeFailed) return "probeFailed";
  const observedAtMs = observation.checkedAtMs;
  if (
    !Number.isFinite(observedAtMs) ||
    observedAtMs > nowMs + CLOCK_TOLERANCE_MS ||
    nowMs - observedAtMs > MAX_OBSERVATION_AGE_MS
  ) {
    return "stale";
  }
  const startMs = currentWindowStart(window, measure, observedAtMs);
  if (startMs === null) return "noReset";
  // A specific reason, such as another account's usage, says more than missing coverage.
  let reason: CalibrationBlock | null = null;
  for (const history of input.costs) {
    if (typeof history === "string") {
      if (reason === null || reason === "incomplete") reason = history;
      continue;
    }
    // Data must reach the reading and must not run far past it, or the two mix moments.
    if (
      history.coverageStartMs > startMs ||
      history.dataEndMs < observedAtMs - CLOCK_TOLERANCE_MS ||
      history.dataEndMs - observedAtMs > MAX_OBSERVATION_AGE_MS
    ) {
      reason ??= "incomplete";
      continue;
    }
    return calibrateWindow({
      measure,
      usedPercent: window.usedPercent,
      costUsd: costSince(history.periods, startMs, observedAtMs, history.dataEndMs),
      publicUsd: input.publicUsd,
      observedAtMs,
    });
  }
  return reason ?? "incomplete";
}

/**
 * True only when a successful, recent reading of a plan known to drop the 5-hour limit lists
 * the provider-wide weekly window and no 5-hour window at all. Missing data is not proof.
 */
export function sessionLimitAbsenceVerified(
  detectedPlanId: string | null,
  observation: LimitObservation | undefined,
  nowMs: number,
): boolean {
  if (observation === undefined || observation.probeFailed) return false;
  if (detectedPlanId === null || !WEEKLY_ONLY_PLANS.has(detectedPlanId)) return false;
  const age = nowMs - observation.checkedAtMs;
  if (!(age >= -CLOCK_TOLERANCE_MS && age <= STRUCTURE_MAX_AGE_MS)) return false;
  return (
    mainLimitWindow(observation.windows, "weekly") !== undefined &&
    !observation.windows.some((window) => window.kind === "session")
  );
}

export interface RememberedCalibration {
  readonly usdPerWindow: number;
  readonly usedPercent: number;
  /** When the live reading behind it was taken. */
  readonly at: number;
  readonly planId: string;
  /** The account or credential it was measured on. */
  readonly account: string;
}

/** Remembered calibrations older than this predate most plan and pricing changes. */
export const REMEMBERED_MAX_AGE_MS = 21 * 24 * 3_600_000;

export type RememberedCalibrations = {
  readonly [P in EstimateProvider]?:
    | { readonly [M in LimitMeasure]?: RememberedCalibration | undefined }
    | undefined;
};

const isPositiveFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

function parseRememberedEntry(raw: unknown): RememberedCalibration | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const entry = raw as Record<string, unknown>;
  if (
    !isPositiveFinite(entry.usdPerWindow) ||
    !isPositiveFinite(entry.usedPercent) ||
    entry.usedPercent > 100 ||
    !isPositiveFinite(entry.at) ||
    !isNonEmptyString(entry.planId) ||
    !isNonEmptyString(entry.account)
  ) {
    return undefined;
  }
  return {
    usdPerWindow: entry.usdPerWindow,
    usedPercent: entry.usedPercent,
    at: entry.at,
    planId: entry.planId,
    account: entry.account,
  };
}

/** Keeps each well-formed stored entry and drops the rest one by one. */
export function parseRememberedCalibrations(raw: unknown): RememberedCalibrations {
  if (typeof raw !== "object" || raw === null) return {};
  const result: Partial<
    Record<EstimateProvider, Partial<Record<LimitMeasure, RememberedCalibration>>>
  > = {};
  for (const provider of ESTIMATE_PROVIDERS) {
    const byMeasure = (raw as Record<string, unknown>)[provider];
    if (typeof byMeasure !== "object" || byMeasure === null) continue;
    for (const measure of ["weekly", "session"] as const) {
      const entry = parseRememberedEntry((byMeasure as Record<string, unknown>)[measure]);
      if (entry !== undefined) (result[provider] ??= {})[measure] = entry;
    }
  }
  return result;
}

/** A remembered entry applies only to its own account and plan, within its age limit. */
export function rememberedApplies(
  remembered: RememberedCalibration | undefined,
  account: string | null,
  planId: string,
  nowMs: number,
): remembered is RememberedCalibration {
  if (remembered === undefined || account === null) return false;
  const age = nowMs - remembered.at;
  return (
    remembered.account === account &&
    remembered.planId === planId &&
    isPositiveFinite(remembered.usdPerWindow) &&
    age >= 0 &&
    age <= REMEMBERED_MAX_AGE_MS
  );
}

/**
 * calibrated, remembered and public are estimates; noLimit is a verified absence; unknown means
 * no figure is available for a window the account may have.
 */
export type RateBasis = "calibrated" | "remembered" | "public" | "noLimit" | "unknown";

export interface LimitRate {
  readonly basis: RateBasis;
  /** API-priced USD per 100% of the window; null for noLimit and unknown. */
  readonly usdPerWindow: number | null;
  readonly usedPercent?: number;
  /** When the live reading behind a calibrated or remembered rate was taken. */
  readonly observedAtMs?: number;
  /** Set when this window's own data disagreed too much with the public figure to trust. */
  readonly rejectedUsdPerWindow?: number;
  /** Why this window's own reading did not calibrate. */
  readonly blocked?: CalibrationBlock;
  /** A successful reading listed no such window without proving the account has none. */
  readonly windowUnreported?: boolean;
}

export function resolveRate(input: {
  readonly measure: LimitMeasure;
  readonly plan: SubscriptionPlan;
  readonly verifiedNoLimit: boolean;
  readonly windowUnreported: boolean;
  readonly calibration: Calibration | CalibrationBlock | null;
  readonly remembered: RememberedCalibration | undefined;
  /** Null when the account is unknown, so nothing remembered can be matched to it. */
  readonly account: string | null;
  readonly nowMs: number;
}): LimitRate {
  const { measure, plan, calibration, remembered, nowMs } = input;
  if (input.verifiedNoLimit) return { basis: "noLimit", usdPerWindow: null };
  if (typeof calibration === "object" && calibration?.kind === "calibrated") {
    return {
      basis: "calibrated",
      usdPerWindow: calibration.usdPerWindow,
      usedPercent: calibration.usedPercent,
      observedAtMs: calibration.observedAtMs,
    };
  }
  const notes = {
    ...(typeof calibration === "object" && calibration?.kind === "outOfRange"
      ? { rejectedUsdPerWindow: calibration.usdPerWindow }
      : {}),
    ...(typeof calibration === "string" ? { blocked: calibration } : {}),
    ...(typeof calibration === "object" && calibration?.kind === "thin"
      ? { blocked: "thin" as const }
      : {}),
    ...(input.windowUnreported ? { windowUnreported: true } : {}),
  };
  if (rememberedApplies(remembered, input.account, plan.id, nowMs)) {
    return {
      basis: "remembered",
      usdPerWindow: remembered.usdPerWindow,
      usedPercent: remembered.usedPercent,
      observedAtMs: remembered.at,
      ...notes,
    };
  }
  const publicUsd = measure === "weekly" ? plan.weeklyUsd : plan.sessionUsd;
  return publicUsd === null
    ? { basis: "unknown", usdPerWindow: null, ...notes }
    : { basis: "public", usdPerWindow: publicUsd, ...notes };
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

export interface ProviderLimitEstimate {
  readonly provider: EstimateProvider;
  readonly plan: SubscriptionPlan;
  readonly planSource: PlanSource;
  readonly detectedPlanId: string | null;
  /** The account the rates were measured on; null when unknown or when several are selected. */
  readonly account: string | null;
  readonly rates: Readonly<Record<LimitMeasure, LimitRate>>;
}

/** What a provider's cost history can offer for calibration. */
export type ProviderCosts =
  | {
      /** Hourly first: it resolves the 5-hour window and recent weekly starts more finely. */
      readonly hourly: CostHistory | CalibrationBlock;
      readonly daily: CostHistory | CalibrationBlock;
    }
  | { readonly blocked: CalibrationBlock };

/**
 * Builds one provider's rates from one account's live reading. Each window calibrates only from
 * a current, successful reading with complete cost history of that account; otherwise it falls
 * back to a remembered figure for the same account and plan, then to the public figure.
 */
export function estimateProviderLimits(input: {
  readonly provider: EstimateProvider;
  readonly planSetting: string | undefined;
  readonly auth:
    | { readonly type?: string | undefined; readonly label?: string | undefined }
    | undefined;
  readonly observation: LimitObservation | undefined;
  readonly account: string | null;
  readonly costs: ProviderCosts;
  readonly remembered: RememberedCalibrations;
  readonly nowMs: number;
}): ProviderLimitEstimate {
  const { provider, observation, costs, nowMs } = input;
  const detectedPlanId = detectPlan(provider, input.auth);
  const { plan, source } = resolvePlan(provider, input.planSetting, detectedPlanId);
  const readingSucceeded =
    observation !== undefined && !observation.probeFailed && observation.windows.length > 0;

  const rateFor = (measure: LimitMeasure): LimitRate => {
    const verifiedNoLimit =
      measure === "session" && sessionLimitAbsenceVerified(detectedPlanId, observation, nowMs);
    const window =
      observation === undefined ? undefined : mainLimitWindow(observation.windows, measure);
    const publicUsd = measure === "weekly" ? plan.weeklyUsd : plan.sessionUsd;
    let calibration: Calibration | CalibrationBlock | null = null;
    if (observation?.probeFailed === true) calibration = "probeFailed";
    else if ("blocked" in costs) calibration = costs.blocked;
    else if (observation === undefined || window === undefined) calibration = "noReading";
    else {
      calibration = calibrateObservation({
        measure,
        observation,
        window,
        costs: [costs.hourly, costs.daily],
        publicUsd,
        nowMs,
      });
    }
    return resolveRate({
      measure,
      plan,
      verifiedNoLimit,
      windowUnreported: readingSucceeded && window === undefined && !verifiedNoLimit,
      calibration,
      remembered: input.remembered[provider]?.[measure],
      account: input.account,
      nowMs,
    });
  };

  return {
    provider,
    plan,
    planSource: source,
    detectedPlanId,
    account: input.account,
    rates: { weekly: rateFor("weekly"), session: rateFor("session") },
  };
}

/**
 * Keeps each calibration under its account so the next window can use it before it has enough
 * data. A newer reading replaces an older one; another account or plan replaces it outright.
 */
export function rememberCalibrations(
  previous: RememberedCalibrations,
  estimates: readonly ProviderLimitEstimate[],
  nowMs: number,
): RememberedCalibrations {
  const next: Record<string, Record<string, RememberedCalibration | undefined>> = {};
  let changed = false;
  for (const estimate of estimates) {
    if (estimate.account === null) continue;
    for (const measure of ["weekly", "session"] as const) {
      const rate = estimate.rates[measure];
      if (
        rate.basis !== "calibrated" ||
        rate.usdPerWindow === null ||
        rate.observedAtMs === undefined ||
        rate.usedPercent === undefined
      ) {
        continue;
      }
      // Never stamp a reading later than now, so its age stays nonnegative.
      const at = Math.min(rate.observedAtMs, nowMs);
      const current = previous[estimate.provider]?.[measure];
      if (
        current !== undefined &&
        current.account === estimate.account &&
        current.planId === estimate.plan.id &&
        current.at >= at
      ) {
        continue;
      }
      const forProvider = (next[estimate.provider] ??= { ...previous[estimate.provider] });
      forProvider[measure] = {
        usdPerWindow: rate.usdPerWindow,
        usedPercent: rate.usedPercent,
        at,
        planId: estimate.plan.id,
        account: estimate.account,
      };
      changed = true;
    }
  }
  return changed ? { ...previous, ...next } : previous;
}
