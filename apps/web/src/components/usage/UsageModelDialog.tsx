import { formatPercent, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { LIMIT_MEASURE_LABEL, formatLimitShare } from "@t3tools/shared/usageEstimate";
import { isModelCostUnknown, type ModelTotals } from "@t3tools/shared/usageMerge";

import { mergeAnsweredUsage, type EnvironmentUsageStatus } from "../../state/usage";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { UsageProviderChart, type UsageChartMetric } from "./UsageProviderChart";
import { UsageShareBar } from "./UsageShareBar";
import {
  cacheHitRate,
  costPerMillionTokens,
  costTypeSegments,
  limitShareSegments,
  speedCostSegments,
  tokenTypeSegments,
} from "./usageBreakdown";
import { shareOf, useLimitEstimates } from "./usageLimitEstimates";
import { PROVIDER_PRESENTATION } from "./usageProviders";

export interface UsageChartWindow {
  readonly days: readonly string[];
  readonly hours: readonly string[];
  readonly resolution: "day" | "hour";
  readonly timeZone: string;
  readonly referenceTime: string | undefined;
  readonly hour12: boolean;
}

export function UsageModelDialog({
  model,
  environments,
  metric,
  chartWindow,
  onSetPrice,
  onClose,
}: {
  readonly model: ModelTotals;
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly metric: UsageChartMetric;
  readonly chartWindow: UsageChartWindow;
  readonly onSetPrice: () => void;
  readonly onClose: () => void;
}) {
  const usage = mergeAnsweredUsage(
    environments,
    (bucket) => bucket.provider === model.provider && bucket.model === model.model,
  );
  const providers = [model.provider];
  const presentation = PROVIDER_PRESENTATION[model.provider];
  const costUnknown = isModelCostUnknown(model);
  const hitRate = cacheHitRate(model);
  const perMillion = costPerMillionTokens(model);
  // Present only in the Usage view.
  const estimates = useLimitEstimates();
  const share = (measure: "weekly" | "session") =>
    estimates === null || costUnknown
      ? null
      : shareOf(estimates, model.provider, model.costUsd, measure);
  const usdPerWindow = estimates?.rates.get(model.provider);
  const stats = (
    estimates === null
      ? [
          { label: "Cost", value: costUnknown ? "Unpriced" : formatUsd(model.costUsd) },
          { label: "Tokens", value: formatTokens(model.totalTokens) },
          perMillion === null ? null : { label: "Per 1M tokens", value: formatUsd(perMillion) },
          hitRate === null ? null : { label: "Cache hit", value: formatPercent(hitRate) },
        ]
      : [
          { label: "Weekly", value: costUnknown ? "Unpriced" : formatLimitShare(share("weekly")) },
          { label: "5-hour", value: costUnknown ? "Unpriced" : formatLimitShare(share("session")) },
          { label: "Tokens", value: formatTokens(model.totalTokens) },
          hitRate === null ? null : { label: "Cache hit", value: formatPercent(hitRate) },
        ]
  ).filter((stat) => stat !== null);
  const measureShare = estimates === null ? null : share(estimates.measure);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <ProviderInstanceIcon
              driverKind={presentation.driverKind}
              displayName={presentation.label}
              iconClassName="size-5"
            />
            <DialogTitle>{model.model}</DialogTitle>
          </div>
          <DialogDescription>
            {presentation.label}
            {estimates !== null
              ? measureShare === null
                ? ""
                : ` · ${formatLimitShare(measureShare)} of the ${LIMIT_MEASURE_LABEL[estimates.measure]} limit · estimate`
              : costUnknown
                ? ""
                : ` · ${formatPercent(model.costShare)} of cost`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-8">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
              {stats.map((stat) => (
                <div key={stat.label} className="flex min-w-0 flex-col gap-0.5">
                  <dt className="text-xs text-muted-foreground">{stat.label}</dt>
                  <dd className="text-2xl font-semibold text-foreground">{stat.value}</dd>
                </div>
              ))}
            </dl>

            {/* Unpriced cost is unknown, not zero, so its trend shows tokens. */}
            <UsageProviderChart
              providers={providers}
              days={chartWindow.days}
              daily={usage.daily}
              hours={chartWindow.hours}
              hourly={usage.hourly}
              metric={
                costUnknown || (metric === "share" && usdPerWindow === undefined)
                  ? "tokens"
                  : metric
              }
              shareRates={estimates?.rates}
              shareLabel={
                estimates === null ? undefined : `${LIMIT_MEASURE_LABEL[estimates.measure]} limit`
              }
              referenceTime={chartWindow.referenceTime}
              resolution={chartWindow.resolution}
              timeZone={chartWindow.timeZone}
              hour12={chartWindow.hour12}
            />

            <div className="grid gap-x-10 gap-y-8 sm:grid-cols-2">
              {costUnknown ? null : estimates !== null ? (
                usdPerWindow === undefined ? null : (
                  <UsageShareBar
                    label="Usage by type"
                    segments={limitShareSegments([
                      { segments: costTypeSegments(usage.categoryCost), usdPerWindow },
                    ])}
                    format={formatLimitShare}
                  />
                )
              ) : (
                <UsageShareBar
                  label="Cost by type"
                  segments={costTypeSegments(usage.categoryCost)}
                  format={formatUsd}
                />
              )}
              <UsageShareBar
                label="Tokens by type"
                segments={tokenTypeSegments(model.tokens)}
                format={formatTokens}
              />
              {usage.speedCost.fast + usage.speedCost.ultrafast > 0 ? (
                estimates !== null ? (
                  usdPerWindow === undefined ? null : (
                    <UsageShareBar
                      label="Usage by speed"
                      segments={limitShareSegments([
                        { segments: speedCostSegments(usage.speedCost), usdPerWindow },
                      ])}
                      format={formatLimitShare}
                    />
                  )
                ) : (
                  <UsageShareBar
                    label="Cost by speed"
                    segments={speedCostSegments(usage.speedCost)}
                    format={formatUsd}
                    aside={<SpeedPremium premiumUsd={usage.speedCost.premium} />}
                  />
                )
              ) : null}
            </div>
          </div>
        </DialogPanel>
        {model.unpricedTokens > 0 ? (
          <DialogFooter variant="bare" className="items-center sm:justify-between">
            <span className="text-xs text-muted-foreground">
              {formatTokens(model.unpricedTokens)} tokens have no known price
            </span>
            <Button onClick={onSetPrice}>Set price</Button>
          </DialogFooter>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

export function SpeedPremium({ premiumUsd }: { readonly premiumUsd: number }) {
  return (
    <span className="text-xs text-muted-foreground">
      Premium <span className="text-foreground tabular-nums">{formatUsd(premiumUsd)}</span>
    </span>
  );
}
