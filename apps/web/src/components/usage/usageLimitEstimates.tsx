import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, UsageProviderKind } from "@t3tools/contracts";
import {
  ESTIMATE_PROVIDERS,
  limitShare,
  rememberCalibrations,
  type EstimateProvider,
  type LimitMeasure,
  type ProviderLimitEstimate,
} from "@t3tools/shared/usageEstimate";
import { makeWindow } from "@t3tools/shared/usageFormat";
import {
  createContext,
  use,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useState,
  type ReactNode,
  type Ref,
} from "react";

import { environmentPresentations } from "../../state/presentation";
import { useUsage } from "../../state/usage";
import type { ShareRates } from "./UsageProviderChart";
import {
  estimateLimits,
  readAccountLedger,
  readRemembered,
  updateAccountLedger,
  writeAccountLedger,
  writeRemembered,
  type AccountLedger,
  type EnvironmentProviders,
} from "./usageLimitCalibration";

export interface LimitEstimates {
  readonly measure: LimitMeasure;
  readonly byProvider: ReadonlyMap<EstimateProvider, ProviderLimitEstimate>;
  /** Dollars per 100% of the measured window, for providers with a figure for it. */
  readonly rates: ShareRates;
  readonly onMeasureChange: (measure: LimitMeasure) => void;
  readonly onPlanChange: (provider: EstimateProvider, planId: string | undefined) => void;
}

/** Lets the Usage page refresh the calibration windows together with its own refresh. */
export interface LimitEstimatesHandle {
  readonly refresh: () => Promise<void>;
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

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function calibrationWindows() {
  const now = new Date();
  // Eight days reach back past the start of any weekly window that is still open.
  return { daily: makeWindow(8, now, "day"), hourly: makeWindow(1, now, "hour") };
}

const NO_HIDDEN: ReadonlySet<UsageProviderKind> = new Set();

function LimitEstimatesValue({
  ref,
  nowMs,
  refreshing,
  selectedEnvironmentIds,
  hiddenProviders,
  measure,
  planSettings,
  onMeasureChange,
  onPlanChange,
  children,
}: {
  readonly ref?: Ref<LimitEstimatesHandle>;
  /** When live limits were last read; older readings than the freshness bound do not calibrate. */
  readonly nowMs: number;
  /** A page refresh is in flight, so readings and costs may be from different moments. */
  readonly refreshing: boolean;
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
  readonly measure: LimitMeasure;
  readonly planSettings: { readonly [P in EstimateProvider]?: string | undefined };
  readonly onMeasureChange: (measure: LimitMeasure) => void;
  readonly onPlanChange: (provider: EstimateProvider, planId: string | undefined) => void;
  readonly children: ReactNode;
}) {
  // Fixed between refreshes so each window keeps one cache key.
  const [windows, setWindows] = useState(calibrationWindows);
  // Every environment, whatever the selection: an account's cost may sit in any of them.
  const daily = useUsage(windows.daily, null, NO_HIDDEN);
  const hourly = useUsage(windows.hourly, null, NO_HIDDEN);
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  // Read once; later calibrations only matter to the next visit.
  const [remembered] = useState(() => readRemembered(browserStorage()));
  const [seenAccounts, setSeenAccounts] = useState(() => readAccountLedger(browserStorage()));

  useImperativeHandle(ref, () => ({
    refresh: async () => {
      const next = calibrationWindows();
      setWindows(next);
      // The daily key stays the same all day, so only an explicit refresh re-reads it.
      await Promise.all([daily.refresh(next.daily), hourly.refresh(next.hourly)]);
    },
  }));

  const environments: EnvironmentProviders[] = [...presentations].map(
    ([environmentId, presentation]) => ({
      environmentId,
      providers: presentation.serverConfig?.providers ?? null,
    }),
  );
  // A new or switched account counts from when it is first seen, so earlier history in its
  // home never calibrates it.
  const accounts = updateAccountLedger(seenAccounts, environments, nowMs);
  const accountsKey = accounts === seenAccounts ? "" : JSON.stringify(accounts);
  const persistAccounts = useEffectEvent(() => {
    const storage = browserStorage();
    // Another tab may have seen the same account earlier; its stamp stays valid.
    const next: Record<string, AccountLedger[string]> = { ...accounts };
    for (const [key, entry] of Object.entries(readAccountLedger(storage))) {
      const current = next[key];
      if (entry === undefined) continue;
      if (current === undefined) next[key] = entry;
      else if (current.account === entry.account && entry.sinceMs < current.sinceMs) {
        next[key] = entry;
      }
    }
    writeAccountLedger(storage, next);
    setSeenAccounts(next);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stamps newly seen accounts once, so their since time stays fixed across renders and visits
  useEffect(() => {
    if (accountsKey !== "") persistAccounts();
  }, [accountsKey]);

  const estimates = estimateLimits({
    providers: ESTIMATE_PROVIDERS.filter((provider) => !hiddenProviders.has(provider)),
    environments,
    selectedEnvironmentIds,
    daily: { window: windows.daily, statuses: daily.environments },
    hourly: { window: windows.hourly, statuses: hourly.environments },
    planSettings,
    remembered,
    accounts,
    nowMs,
  });

  // Only settled calibrations persist; the key changes with each new reading or figure.
  const toRemember = refreshing ? [] : estimates.filter((estimate) => estimate.account !== null);
  const rememberKey = JSON.stringify(
    toRemember.flatMap((estimate) =>
      (["weekly", "session"] as const).flatMap((measureKey) => {
        const rate = estimate.rates[measureKey];
        return rate.basis === "calibrated"
          ? [estimate.provider, measureKey, estimate.account, rate.observedAtMs, rate.usdPerWindow]
          : [];
      }),
    ),
  );
  const persistCalibrations = useEffectEvent(() => {
    const storage = browserStorage();
    const stored = readRemembered(storage);
    const next = rememberCalibrations(stored, toRemember, nowMs);
    if (next !== stored) writeRemembered(storage, next);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- persists settled calibrations so the next window starts from this account's own figure
  useEffect(() => {
    if (rememberKey !== "[]") persistCalibrations();
  }, [rememberKey]);

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
