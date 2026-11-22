// @effect-diagnostics globalDate:off -- Limit readings and usage reads are wall-clock instants.
/**
 * Decides which live limit reading and which cost history may calibrate a provider's limits.
 * A reading belongs to one account, so cost counts only from environments known to use that
 * account, and only once every such environment has settled on complete data.
 */
import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type ServerProvider,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import {
  dailyCostPeriods,
  estimateProviderLimits,
  hourlyCostPeriods,
  parseRememberedCalibrations,
  zonedDayStartMs,
  type CalibrationBlock,
  type CostHistory,
  type EstimateProvider,
  type LimitObservation,
  type ProviderLimitEstimate,
  type RememberedCalibrations,
} from "@t3tools/shared/usageEstimate";
import { isCompatibleUsageContractVersion, mergeUsage } from "@t3tools/shared/usageMerge";

import type { EnvironmentUsageStatus } from "../../state/usage";
import { PROVIDER_PRESENTATION } from "./usageProviders";

export interface EnvironmentProviders {
  readonly environmentId: EnvironmentId;
  /** Null when the environment's server config is not known. */
  readonly providers: readonly ServerProvider[] | null;
}

function hashText(text: string): string {
  // FNV-1a keeps account emails out of browser storage while staying stable.
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** A stable account identity: the credential fingerprint, else the signed-in email. */
export function accountIdentity(provider: ServerProvider): string | null {
  const fingerprint = provider.usageLimits?.credentialFingerprint;
  if (fingerprint !== undefined) return `credential:${provider.driver}:${fingerprint}`;
  const email = provider.auth.email;
  if (email !== undefined)
    return `email:${provider.driver}:${hashText(email.trim().toLowerCase())}`;
  return null;
}

function instancesOf(
  providers: readonly ServerProvider[],
  provider: EstimateProvider,
): readonly ServerProvider[] {
  const driver = PROVIDER_PRESENTATION[provider].driverKind;
  // A signed-out instance has no account to compare.
  return providers.filter(
    (entry) => entry.driver === driver && entry.enabled && entry.auth.status !== "unauthenticated",
  );
}

function observationOf(server: ServerProvider): LimitObservation | undefined {
  const limits = server.usageLimits;
  if (limits === undefined || limits.windows.length === 0) return undefined;
  return {
    windows: limits.windows,
    checkedAtMs: Date.parse(limits.checkedAt),
    probeFailed: limits.unavailable?.reason === "probeFailed",
  };
}

interface PickedAccount {
  readonly environmentId: EnvironmentId | null;
  readonly server: ServerProvider | undefined;
  readonly observation: LimitObservation | undefined;
  /** Null when the account has no stable identity or several accounts are selected. */
  readonly account: string | null;
  /** The selected environments use more than one account, or accounts that cannot be told apart. */
  readonly mixedAccounts: boolean;
}

/**
 * Picks the account the selected environments use for a provider. When they span several
 * accounts, or instances whose accounts cannot be told apart, no single reading describes them.
 */
function pickAccount(
  selected: readonly EnvironmentProviders[],
  provider: EstimateProvider,
): PickedAccount {
  const candidates = selected.flatMap(({ environmentId, providers }) =>
    instancesOf(providers ?? [], provider).map((server) => ({ environmentId, server })),
  );
  const identities = new Set(
    candidates.map(
      ({ environmentId, server }) =>
        accountIdentity(server) ?? `instance:${environmentId}:${server.instanceId}`,
    ),
  );
  const mixedAccounts = identities.size > 1;
  const ranked = candidates
    .map((candidate) => ({ ...candidate, observation: observationOf(candidate.server) }))
    .toSorted((left, right) => {
      // Prefer a successful reading, then the newest.
      const failed = Number(left.observation?.probeFailed ?? true);
      const otherFailed = Number(right.observation?.probeFailed ?? true);
      if (failed !== otherFailed) return failed - otherFailed;
      return (
        (right.observation?.checkedAtMs ?? -Infinity) - (left.observation?.checkedAtMs ?? -Infinity)
      );
    });
  const best =
    ranked.find((entry) => entry.observation !== undefined) ??
    ranked.find((entry) => entry.server.auth.label !== undefined) ??
    ranked[0];
  return {
    environmentId: best?.environmentId ?? null,
    server: best?.server,
    observation: best?.observation,
    account: mixedAccounts || best === undefined ? null : accountIdentity(best.server),
    mixedAccounts,
  };
}

/** none: the environment runs no instance of the provider, yet may still hold its transcripts. */
type Relation = "same" | "other" | "none" | "unknown";

/** Whether an environment's instances of a provider all use the observed account. */
function relationTo(
  environment: EnvironmentProviders | undefined,
  provider: EstimateProvider,
  observed: { readonly environmentId: EnvironmentId; readonly server: ServerProvider },
  account: string | null,
): Relation {
  if (environment === undefined || environment.providers === null) return "unknown";
  const instances = instancesOf(environment.providers, provider);
  if (
    environment.environmentId === observed.environmentId &&
    instances.length === 1 &&
    instances[0]?.instanceId === observed.server.instanceId
  ) {
    return "same";
  }
  if (instances.length === 0) return "none";
  if (account === null) return "unknown";
  const identities = instances.map(accountIdentity);
  if (identities.every((identity) => identity === account)) return "same";
  if (identities.every((identity) => identity !== null && identity !== account)) return "other";
  return "unknown";
}

function providerCost(status: EnvironmentUsageStatus, provider: EstimateProvider): number {
  return (
    status.summary?.buckets.reduce(
      (sum, bucket) => (bucket.provider === provider ? sum + bucket.costUsd : sum),
      0,
    ) ?? 0
  );
}

/**
 * The observed account's cost history from one usage query, or why it cannot calibrate.
 * Every environment that may hold this account's usage must have answered with settled,
 * successful, compatible data; usage of an account that cannot be told apart blocks it.
 * Environments without diagnostics access are outside what T3 can see, like other apps.
 */
function accountCostHistory(input: {
  readonly provider: EstimateProvider;
  readonly picked: PickedAccount;
  readonly window: UsageSummaryInput;
  readonly statuses: readonly EnvironmentUsageStatus[];
  readonly environments: readonly EnvironmentProviders[];
}): CostHistory | CalibrationBlock {
  const { provider, picked, window } = input;
  if (picked.mixedAccounts) return "mixedAccounts";
  if (picked.server === undefined || picked.environmentId === null) return "noReading";
  const observed = { environmentId: picked.environmentId, server: picked.server };
  const byId = new Map(input.environments.map((entry) => [entry.environmentId, entry]));
  const included: { readonly status: EnvironmentUsageStatus; readonly summary: UsageSummary }[] =
    [];
  let observedIncluded = false;
  for (const status of input.statuses) {
    if (!status.canReadDiagnostics) continue;
    const relation = relationTo(byId.get(status.environmentId), provider, observed, picked.account);
    if (relation === "other") continue;
    const isObserved = status.environmentId === observed.environmentId;
    const { summary } = status;
    if (summary === null || status.error !== null) {
      // An unanswered environment may still hold this account's usage.
      if (isObserved || relation !== "none") return "incomplete";
      continue;
    }
    if (!isObserved && providerCost(status, provider) === 0) {
      // A refresh may still add cost; a settled zero adds nothing.
      if (status.isPending && relation !== "none") return "incomplete";
      continue;
    }
    if (relation !== "same") return "otherAccounts";
    if (status.isPending) return "incomplete";
    if (!isCompatibleUsageContractVersion(summary.contractVersion, USAGE_CONTRACT_VERSION)) {
      return "incomplete";
    }
    const unsettled = summary.sources.some(
      (source) =>
        source.fingerprint.provider === provider &&
        (source.refreshing === true || source.status === "partial" || source.status === "failed"),
    );
    if (unsettled) return "incomplete";
    included.push({ status, summary });
    if (isObserved) observedIncluded = true;
  }
  if (!observedIncluded) return "incomplete";

  const merged = mergeUsage(
    included.map(({ status, summary }) => ({
      environmentId: status.environmentId,
      label: status.label,
      summary: {
        ...summary,
        buckets: summary.buckets.filter((bucket) => bucket.provider === provider),
      },
    })),
    USAGE_CONTRACT_VERSION,
  );
  let dataEndMs = Math.min(...included.map(({ summary }) => Date.parse(summary.readAt)));
  if (window.resolution === "hour") {
    if (window.sinceTime === undefined || window.untilTime === undefined) return "incomplete";
    // The query stops at its own end, even when the server read later.
    dataEndMs = Math.min(dataEndMs, Date.parse(window.untilTime));
    return {
      periods: hourlyCostPeriods(merged.hourly, provider),
      coverageStartMs: Date.parse(window.sinceTime),
      dataEndMs,
    };
  }
  return {
    periods: dailyCostPeriods(merged.daily, provider, window.timeZone),
    coverageStartMs: zonedDayStartMs(window.sinceDay, window.timeZone),
    dataEndMs,
  };
}

export interface CalibrationQuery {
  readonly window: UsageSummaryInput;
  /** Every environment's answer, whatever the page selection. */
  readonly statuses: readonly EnvironmentUsageStatus[];
}

/** Each provider's limit estimate for the selected environments, as the Usage view shows it. */
export function estimateLimits(input: {
  readonly providers: readonly EstimateProvider[];
  readonly environments: readonly EnvironmentProviders[];
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly daily: CalibrationQuery;
  readonly hourly: CalibrationQuery;
  readonly planSettings: { readonly [P in EstimateProvider]?: string | undefined };
  readonly remembered: RememberedCalibrations;
  readonly nowMs: number;
}): readonly ProviderLimitEstimate[] {
  const { environments, selectedEnvironmentIds } = input;
  const selected = environments.filter(
    ({ environmentId }) =>
      selectedEnvironmentIds === null || selectedEnvironmentIds.has(environmentId),
  );
  return input.providers.map((provider) => {
    const picked = pickAccount(selected, provider);
    const history = (query: CalibrationQuery) =>
      accountCostHistory({
        provider,
        picked,
        window: query.window,
        statuses: query.statuses,
        environments,
      });
    return estimateProviderLimits({
      provider,
      planSetting: input.planSettings[provider],
      auth: picked.server?.auth,
      observation: picked.observation,
      account: picked.account,
      costs: picked.mixedAccounts
        ? { blocked: "mixedAccounts" }
        : { hourly: history(input.hourly), daily: history(input.daily) },
      remembered: input.remembered,
      nowMs: input.nowMs,
    });
  });
}

/** v2 scopes each entry to an account; unscoped v1 entries are never read. */
export const CALIBRATION_KEY = "t3code:usage-limit-calibration:v2";
const LEGACY_CALIBRATION_KEYS = ["t3code:usage-limit-calibration:v1"];

export function readRemembered(
  storage: Pick<Storage, "getItem"> | undefined,
): RememberedCalibrations {
  try {
    const raw = storage?.getItem(CALIBRATION_KEY);
    return raw ? parseRememberedCalibrations(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

export function writeRemembered(
  storage: Pick<Storage, "setItem" | "removeItem"> | undefined,
  value: RememberedCalibrations,
): void {
  try {
    storage?.setItem(CALIBRATION_KEY, JSON.stringify(value));
    for (const key of LEGACY_CALIBRATION_KEYS) storage?.removeItem(key);
  } catch {
    // A blocked store only loses the fallback; current windows still calibrate.
  }
}
