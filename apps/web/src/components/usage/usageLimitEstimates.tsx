import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerProvider, UsageProviderKind } from "@t3tools/contracts";
import {
  ESTIMATE_PROVIDERS,
  estimateProviderLimits,
  limitShare,
  rememberCalibrations,
  type EstimateProvider,
  type LimitMeasure,
  type ProviderLimitEstimate,
  type RememberedCalibrations,
  zonedDayStartMs,
} from "@t3tools/shared/usageEstimate";
import { makeWindow } from "@t3tools/shared/usageFormat";
import * as Schema from "effect/Schema";
import { createContext, use, useEffect, useState, type ReactNode } from "react";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import { environmentPresentations } from "../../state/presentation";
import { useUsage } from "../../state/usage";
import type { ShareRates } from "./UsageProviderChart";
import { PROVIDER_PRESENTATION } from "./usageProviders";

export interface LimitEstimates {
  readonly measure: LimitMeasure;
  readonly byProvider: ReadonlyMap<EstimateProvider, ProviderLimitEstimate>;
  /** Dollars per 100% of the measured window, for providers that have that limit. */
  readonly rates: ShareRates;
  readonly onMeasureChange: (measure: LimitMeasure) => void;
  readonly onPlanChange: (provider: EstimateProvider, planId: string | undefined) => void;
}

const LimitEstimatesContext = createContext<LimitEstimates | null>(null);

/** Null outside the Usage view, so the other views never load calibration windows. */
export function useLimitEstimates(): LimitEstimates | null {
  return use(LimitEstimatesContext);
}

export function shareOf(
  estimates: LimitEstimates,
  provider: UsageProviderKind,
  costUsd: number,
  measure: LimitMeasure = estimates.measure,
): number | null {
  const estimate = estimates.byProvider.get(provider as EstimateProvider);
  return estimate === undefined ? null : limitShare(costUsd, estimate.rates[measure]);
}

const RememberedCalibration = Schema.Struct({
  usdPerWindow: Schema.Number,
  usedPercent: Schema.Number,
  at: Schema.Number,
  planId: Schema.String,
});
const RememberedByMeasure = Schema.Struct({
  weekly: Schema.optional(RememberedCalibration),
  session: Schema.optional(RememberedCalibration),
});
const RememberedCalibrationsSchema = Schema.Struct({
  claude: Schema.optional(RememberedByMeasure),
  codex: Schema.optional(RememberedByMeasure),
});
const CALIBRATION_KEY = "t3code:usage-limit-calibration:v1";

function readRemembered(): RememberedCalibrations {
  try {
    return getLocalStorageItem(CALIBRATION_KEY, RememberedCalibrationsSchema) ?? {};
  } catch {
    return {};
  }
}

/** Picks the account whose limits were read most recently among the selected environments. */
function pickProvider(
  providers: readonly ServerProvider[],
  provider: EstimateProvider,
): ServerProvider | undefined {
  const driver = PROVIDER_PRESENTATION[provider].driverKind;
  const candidates = providers.filter((entry) => entry.driver === driver && entry.enabled);
  const withLimits = candidates
    .filter((entry) => (entry.usageLimits?.windows.length ?? 0) > 0)
    .toSorted((left, right) =>
      (right.usageLimits?.checkedAt ?? "").localeCompare(left.usageLimits?.checkedAt ?? ""),
    );
  return (
    withLimits[0] ?? candidates.find((entry) => entry.auth.label !== undefined) ?? candidates[0]
  );
}

function calibrationWindows(epoch: number) {
  const now = new Date();
  // Eight days reach back past the start of any weekly window that is still open.
  return { epoch, daily: makeWindow(8, now, "day"), hourly: makeWindow(1, now, "hour") };
}

function LimitEstimatesValue({
  epoch,
  nowMs,
  selectedEnvironmentIds,
  hiddenProviders,
  measure,
  planSettings,
  onMeasureChange,
  onPlanChange,
  children,
}: {
  /** Bumped by a page refresh, which re-reads the calibration windows at the new time. */
  readonly epoch: number;
  /** When live limits were last read; windows that reset before it no longer calibrate. */
  readonly nowMs: number;
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
  readonly measure: LimitMeasure;
  readonly planSettings: { readonly [P in EstimateProvider]?: string | undefined };
  readonly onMeasureChange: (measure: LimitMeasure) => void;
  readonly onPlanChange: (provider: EstimateProvider, planId: string | undefined) => void;
  readonly children: ReactNode;
}) {
  // Fixed between refreshes so each window keeps one cache key.
  const [savedWindows, setWindows] = useState(() => calibrationWindows(epoch));
  let windows = savedWindows;
  if (savedWindows.epoch !== epoch) {
    windows = calibrationWindows(epoch);
    setWindows(windows);
  }
  const daily = useUsage(windows.daily, selectedEnvironmentIds, hiddenProviders);
  const hourly = useUsage(windows.hourly, selectedEnvironmentIds, hiddenProviders);
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  // Read once; later calibrations only matter to the next visit.
  const [remembered] = useState(readRemembered);

  const serverProviders = [...presentations].flatMap(([environmentId, presentation]) =>
    selectedEnvironmentIds === null || selectedEnvironmentIds.has(environmentId)
      ? (presentation.serverConfig?.providers ?? [])
      : [],
  );
  const coverageStart = (sinceTime: string | undefined) =>
    sinceTime === undefined ? null : Date.parse(sinceTime);
  const estimates = ESTIMATE_PROVIDERS.filter((provider) => !hiddenProviders.has(provider)).map(
    (provider) => {
      const server = pickProvider(serverProviders, provider);
      return estimateProviderLimits({
        provider,
        planSetting: planSettings[provider],
        auth: server?.auth,
        windows: server?.usageLimits?.windows,
        daily: daily.merged.daily,
        dailyCoverageStartMs:
          daily.shown === null
            ? null
            : zonedDayStartMs(windows.daily.sinceDay, windows.daily.timeZone),
        hourly: hourly.merged.hourly,
        hourlyCoverageStartMs:
          hourly.shown === null ? null : coverageStart(windows.hourly.sinceTime),
        timeZone: windows.daily.timeZone,
        remembered,
        nowMs,
      });
    },
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- persists fresh calibrations so the next window starts from this account's own figure
  useEffect(() => {
    const stored = readRemembered();
    const next = rememberCalibrations(stored, estimates, nowMs);
    if (next === stored) return;
    try {
      setLocalStorageItem(CALIBRATION_KEY, next, RememberedCalibrationsSchema);
    } catch {
      // A blocked store only loses the fallback; current windows still calibrate.
    }
  }, [estimates, nowMs]);

  const byProvider = new Map(estimates.map((estimate) => [estimate.provider, estimate]));
  const rates = new Map<UsageProviderKind, number>();
  for (const estimate of estimates) {
    const usd = estimate.rates[measure].usdPerWindow;
    if (usd !== null && usd > 0) rates.set(estimate.provider, usd);
  }
  return (
    <LimitEstimatesContext value={{ measure, byProvider, rates, onMeasureChange, onPlanChange }}>
      {children}
    </LimitEstimatesContext>
  );
}

export function LimitEstimatesScope({
  enabled,
  ...props
}: Parameters<typeof LimitEstimatesValue>[0] & { readonly enabled: boolean }) {
  if (!enabled) return props.children;
  return <LimitEstimatesValue {...props} />;
}
