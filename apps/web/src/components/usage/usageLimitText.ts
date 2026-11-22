import type { UsageProviderKind } from "@t3tools/contracts";
import {
  LIMIT_MEASURE_LABEL,
  formatLimitShare,
  limitShare,
  type CalibrationBlock,
  type EstimateProvider,
  type LimitMeasure,
  type LimitRate,
  type ProviderLimitEstimate,
} from "@t3tools/shared/usageEstimate";
import { formatUsd } from "@t3tools/shared/usageFormat";

import type { LimitEstimates } from "./usageLimitEstimates";

/** Plain-text explanations of limit estimates; a missing figure is never shown as no limit. */

export function shareRowDetail(
  estimates: LimitEstimates,
  provider: UsageProviderKind,
  costUsd: number,
): string {
  const other: LimitMeasure = estimates.measure === "weekly" ? "session" : "weekly";
  const otherRate = estimates.byProvider.get(provider as EstimateProvider)?.rates[other];
  const otherShare = limitShare(costUsd, otherRate);
  const otherText =
    otherShare === null
      ? otherRate?.basis === "noLimit"
        ? `no ${LIMIT_MEASURE_LABEL[other]} limit`
        : `${LIMIT_MEASURE_LABEL[other]} unknown`
      : `${formatLimitShare(otherShare)} of ${LIMIT_MEASURE_LABEL[other]}`;
  return `${otherText} · ${formatUsd(costUsd)} API`;
}

/** Only a verified absence reads as no limit; anything else is unknown. */
export function missingShareLabel(
  estimates: LimitEstimates,
  provider: UsageProviderKind,
  measure: LimitMeasure = estimates.measure,
): string {
  const rate = estimates.byProvider.get(provider as EstimateProvider)?.rates[measure];
  return rate?.basis === "noLimit" ? "No limit" : "Unknown";
}

const BLOCKED_TEXT: Partial<Record<CalibrationBlock, string>> = {
  probeFailed: "The last limit check failed.",
  stale: "The limit reading is too old to calibrate.",
  noReset: "The limit reading has no reset time.",
  incomplete: "Waiting for complete usage data to calibrate.",
  otherAccounts: "Usage from an account T3 can't tell apart blocks calibration.",
  mixedAccounts: "The selected environments use more than one account.",
};

export function rateBasisText(
  rate: LimitRate,
  measure: LimitMeasure,
  estimate: ProviderLimitEstimate,
): string {
  const window = LIMIT_MEASURE_LABEL[measure];
  if (rate.basis === "noLimit") return `No ${window} limit on this account.`;
  const usd = rate.usdPerWindow === null ? "" : `${formatUsd(rate.usdPerWindow)} API fills it`;
  const unreported = rate.windowUnreported ? `No ${window} window reported. ` : "";
  const notes = [
    rate.rejectedUsdPerWindow === undefined
      ? null
      : `This window read ${formatUsd(rate.rejectedUsdPerWindow)}, too far off to trust.`,
    rate.blocked === undefined ? null : (BLOCKED_TEXT[rate.blocked] ?? null),
  ]
    .filter((note) => note !== null)
    .map((note) => ` ${note}`)
    .join("");
  switch (rate.basis) {
    case "calibrated":
      return `${usd}, calibrated from ${Math.round(rate.usedPercent ?? 0)}% used at the last check.`;
    case "remembered":
      return `${unreported}${usd}, calibrated in an earlier window.${notes}`;
    case "public":
      return `${unreported}${usd}, public estimate for ${estimate.plan.label}.${notes}`;
    case "unknown":
      return `${unreported}Unknown: no ${window} figure for ${estimate.plan.label}.${notes}`;
  }
}
