// @effect-diagnostics globalDate:off -- Limit readings and usage reads are wall-clock instants.
/**
 * Decides which live limit reading and cost history may calibrate a provider's limits: cost only
 * from settled environments on that account, and only from homes tied to it (no extra or
 * signed-out homes) since this browser first saw the account on each instance.
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

function isSignedIn(entry: ServerProvider): boolean {
  return entry.enabled && entry.auth.status !== "unauthenticated";
}

function instancesOf(
  providers: readonly ServerProvider[],
  provider: EstimateProvider,
): readonly ServerProvider[] {
  const driver = PROVIDER_PRESENTATION[provider].driverKind;
  // A signed-out instance has no account to compare.
  return providers.filter((entry) => entry.driver === driver && isSignedIn(entry));
}

type LedgerEntry = { readonly account: string; readonly sinceMs: number };

/** Since when this browser has seen each instance signed in to its current account. */
export type AccountLedger = { readonly [instance: string]: LedgerEntry | undefined };

const ledgerKey = (environmentId: EnvironmentId, instanceId: string) =>
  `${environmentId}/${instanceId}`;

/**
 * Records each signed-in instance's account. A new or changed account starts now: its home may
 * hold an earlier account's transcripts, so only windows opening after this can calibrate.
 */
export function updateAccountLedger(
  previous: AccountLedger,
  environments: readonly EnvironmentProviders[],
  nowMs: number,
): AccountLedger {
  let next: Record<string, LedgerEntry | undefined> | null = null;
  for (const { environmentId, providers } of environments) {
    for (const server of providers ?? []) {
      if (!isSignedIn(server)) continue;
      const account = accountIdentity(server);
      if (account === null) continue;
      const key = ledgerKey(environmentId, server.instanceId);
      if (previous[key]?.account === account) continue;
      next ??= { ...previous };
      next[key] = { account, sinceMs: nowMs };
    }
  }
  return next ?? previous;
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

/**
 * Whether every transcript home of the provider in an environment can be tied to the observed
 * account: no disabled or signed-out instance may own one, and there may be no more homes than
 * signed-in instances, such as a default home kept after the instance moved elsewhere.
 */
function homesAttributed(
  environment: EnvironmentProviders,
  summary: UsageSummary,
  provider: EstimateProvider,
  signedIn: number,
): boolean {
  const driver = PROVIDER_PRESENTATION[provider].driverKind;
  const extraInstance = (environment.providers ?? []).some(
    (entry) => entry.driver === driver && !isSignedIn(entry),
  );
  if (extraInstance) return false;
  const homes = summary.sources.filter(
    (source) =>
      source.fingerprint.provider === provider &&
      (source.status !== "missing" ||
        summary.buckets.some(
          (bucket) =>
            bucket.provider === provider &&
            bucket.sourcePath === source.fingerprint.resolvedHomePath,
        )),
  );
  return homes.length <= signedIn;
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
  readonly accounts: AccountLedger;
}): CostHistory | CalibrationBlock {
  const { provider, picked, window } = input;
  if (picked.mixedAccounts) return "mixedAccounts";
  if (picked.server === undefined || picked.environmentId === null) return "noReading";
  const observed = { environmentId: picked.environmentId, server: picked.server };
  const byId = new Map(input.environments.map((entry) => [entry.environmentId, entry]));
  const included: { readonly status: EnvironmentUsageStatus; readonly summary: UsageSummary }[] =
    [];
  let observedIncluded = false;
  let accountSinceMs = Number.NEGATIVE_INFINITY;
  for (const status of input.statuses) {
    if (!status.canReadDiagnostics) continue;
    const environment = byId.get(status.environmentId);
    const relation = relationTo(environment, provider, observed, picked.account);
    if (relation === "other") continue;
    const isObserved = status.environmentId === observed.environmentId;
    const { summary } = status;
    if (summary === null || status.error !== null) {
      // An unanswered environment may still hold this account's usage.
      if (isObserved || relation !== "none") return "incomplete";
      continue;
    }
    const cost = providerCost(status, provider);
    // Zero is a settled zero only once the answer is final, readable and complete: a cached
    // answer while a scan refreshes may still gain cost.
    if (status.isPending) return "incomplete";
    if (!isCompatibleUsageContractVersion(summary.contractVersion, USAGE_CONTRACT_VERSION)) {
      const holdsProvider =
        cost > 0 || summary.sources.some((source) => source.fingerprint.provider === provider);
      if (isObserved || relation !== "none" || holdsProvider) return "incomplete";
      continue;
    }
    const unsettled = summary.sources.some(
      (source) =>
        source.fingerprint.provider === provider &&
        (source.refreshing === true || source.status === "partial" || source.status === "failed"),
    );
    if (unsettled) return "incomplete";
    if (!isObserved && cost === 0) continue;
    if (relation !== "same" || environment === undefined) return "otherAccounts";
    const signedIn = instancesOf(environment.providers ?? [], provider);
    if (!homesAttributed(environment, summary, provider, signedIn.length)) {
      return "unattributedHistory";
    }
    for (const server of signedIn) {
      const seen = input.accounts[ledgerKey(status.environmentId, server.instanceId)];
      // Without a confirmed account, any of this home's history may be another account's.
      const sinceMs =
        seen !== undefined && picked.account !== null && seen.account === picked.account
          ? seen.sinceMs
          : Number.POSITIVE_INFINITY;
      accountSinceMs = Math.max(accountSinceMs, sinceMs);
    }
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
      accountSinceMs,
    };
  }
  return {
    periods: dailyCostPeriods(merged.daily, provider, window.timeZone),
    coverageStartMs: zonedDayStartMs(window.sinceDay, window.timeZone),
    dataEndMs,
    accountSinceMs,
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
  /** Already updated with the current environments. */
  readonly accounts: AccountLedger;
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
        accounts: input.accounts,
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

export const ACCOUNT_LEDGER_KEY = "t3code:usage-limit-accounts:v1";

export function readAccountLedger(storage: Pick<Storage, "getItem"> | undefined): AccountLedger {
  try {
    const raw: unknown = JSON.parse(storage?.getItem(ACCOUNT_LEDGER_KEY) ?? "{}");
    if (typeof raw !== "object" || raw === null) return {};
    const ledger: Record<string, LedgerEntry> = {};
    for (const [key, value] of Object.entries(raw)) {
      const entry = value as { readonly account?: unknown; readonly sinceMs?: unknown } | null;
      if (
        typeof entry?.account === "string" &&
        entry.account.length > 0 &&
        typeof entry.sinceMs === "number" &&
        Number.isFinite(entry.sinceMs) &&
        entry.sinceMs >= 0
      ) {
        ledger[key] = { account: entry.account, sinceMs: entry.sinceMs };
      }
    }
    return ledger;
  } catch {
    return {};
  }
}

export function writeAccountLedger(
  storage: Pick<Storage, "setItem"> | undefined,
  ledger: AccountLedger,
): void {
  try {
    storage?.setItem(ACCOUNT_LEDGER_KEY, JSON.stringify(ledger));
  } catch {
    // A blocked store only means accounts count as newly seen on the next visit.
  }
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
