// @effect-diagnostics globalDate:off -- Fixed instants keep reading and query lifecycles deterministic.
import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type ServerProvider,
  type ServerProviderUsageWindow,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import {
  rememberCalibrations,
  type ProviderLimitEstimate,
  type RememberedCalibrations,
} from "@t3tools/shared/usageEstimate";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentUsageStatus } from "../../state/usage";
import type { LimitEstimates } from "./usageLimitEstimates";
import {
  ACCOUNT_LEDGER_KEY,
  CALIBRATION_KEY,
  accountIdentity,
  estimateLimits,
  readAccountLedger,
  readRemembered,
  updateAccountLedger,
  writeAccountLedger,
  writeRemembered,
  type AccountLedger,
  type EnvironmentProviders,
} from "./usageLimitCalibration";
import { missingShareLabel, rateBasisText } from "./usageLimitText";

const HOUR = 3_600_000;
const MINUTE = 60_000;
const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const ENV_A = "env-a" as EnvironmentId;
const ENV_B = "env-b" as EnvironmentId;

const DAILY: UsageSummaryInput = {
  sinceDay: "2026-11-15" as UsageSummaryInput["sinceDay"],
  untilDay: "2026-11-22" as UsageSummaryInput["untilDay"],
  timeZone: "UTC",
  resolution: "day",
};
const HOURLY: UsageSummaryInput = {
  sinceDay: "2026-11-21" as UsageSummaryInput["sinceDay"],
  untilDay: "2026-11-22" as UsageSummaryInput["untilDay"],
  timeZone: "UTC",
  resolution: "hour",
  sinceTime: iso(NOW - 24 * HOUR),
  untilTime: iso(NOW),
};

/** Opened 2026-11-17T00:00Z; resets in a day and a half. */
const weekly = (usedPercent: number): ServerProviderUsageWindow => ({
  id: "weekly",
  kind: "weekly",
  label: "Weekly",
  usedPercent,
  resetsAt: "2026-11-24T00:00:00.000Z",
  windowDurationMins: 10080,
});

function codex(options: {
  readonly email?: string | null;
  readonly label?: string;
  readonly checkedAtMs?: number;
  readonly probeFailed?: boolean;
  readonly windows?: readonly ServerProviderUsageWindow[];
  readonly instanceId?: string;
}): ServerProvider {
  const email = options.email === undefined ? "a@example.com" : options.email;
  return {
    instanceId: options.instanceId ?? "codex",
    driver: "codex",
    enabled: true,
    installed: true,
    auth: {
      status: "authenticated",
      label: options.label ?? "ChatGPT Pro 200 Subscription",
      ...(email === null ? {} : { email }),
    },
    usageLimits: {
      checkedAt: iso(options.checkedAtMs ?? NOW),
      windows: options.windows ?? [weekly(55)],
      ...(options.probeFailed ? { unavailable: { reason: "probeFailed" } } : {}),
    },
  } as unknown as ServerProvider;
}

const ZERO_TOKENS = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

/** One Codex day bucket per entry of `perDay`, starting 2026-11-17. */
function summary(
  environmentId: EnvironmentId,
  perDay: readonly number[],
  options: {
    readonly readAtMs?: number;
    readonly status?: "ok" | "partial" | "failed";
    readonly refreshing?: boolean;
    readonly contractVersion?: number;
  } = {},
): UsageSummary {
  const home = `/home/${environmentId}/.codex`;
  return {
    contractVersion: options.contractVersion ?? USAGE_CONTRACT_VERSION,
    readAt: iso(options.readAtMs ?? NOW),
    timeZone: "UTC",
    sinceDay: DAILY.sinceDay,
    untilDay: DAILY.untilDay,
    buckets: perDay.map((costUsd, index) => ({
      day: `2026-11-${17 + index}` as UsageSummary["sinceDay"],
      provider: "codex",
      model: "gpt-5",
      sourcePath: home,
      totals: ZERO_TOKENS,
      costUsd,
      cacheSavingsUsd: 0,
      costSource: "modelPriced",
      records: 1,
      unpricedRecords: 0,
      sessions: 1,
    })),
    sources: [
      {
        fingerprint: {
          hostId: environmentId,
          provider: "codex",
          resolvedHomePath: home,
          volumeId: environmentId,
        },
        status: options.status ?? "ok",
        scannedFiles: 1,
        skippedFiles: 0,
        malformedRecords: 0,
        distinctSessions: 1,
        message: null,
        ...(options.refreshing ? { refreshing: true as const } : {}),
      },
    ],
    pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
    scanDurationMs: 0,
  };
}

function status(
  environmentId: EnvironmentId,
  answer: UsageSummary | null,
  options: { readonly isPending?: boolean; readonly error?: string } = {},
): EnvironmentUsageStatus {
  return {
    environmentId,
    label: environmentId,
    isPending: options.isPending ?? answer === null,
    canReadDiagnostics: true,
    isConnected: true,
    error: options.error ?? null,
    summary: answer,
  };
}

/** $100 a day from the 17th through the 21st, then $50 so far today: $550 in the window. */
const WEEK = [100, 100, 100, 100, 100, 50];
const settledA = () => [status(ENV_A, summary(ENV_A, WEEK))];

function run(input: {
  readonly environments: readonly EnvironmentProviders[];
  readonly daily: readonly EnvironmentUsageStatus[];
  readonly hourly?: readonly EnvironmentUsageStatus[];
  readonly selected?: ReadonlySet<EnvironmentId> | null;
  readonly remembered?: RememberedCalibrations;
  /** Defaults to every signed-in account seen long before any window opened. */
  readonly accounts?: AccountLedger;
  readonly nowMs?: number;
}): ProviderLimitEstimate {
  const [estimate] = estimateLimits({
    providers: ["codex"],
    environments: input.environments,
    selectedEnvironmentIds: input.selected ?? null,
    daily: { window: DAILY, statuses: input.daily },
    // Hourly reaches back only a day, so the weekly window relies on daily history.
    hourly: { window: HOURLY, statuses: input.hourly ?? [] },
    planSettings: {},
    remembered: input.remembered ?? {},
    accounts: input.accounts ?? updateAccountLedger({}, input.environments, 0),
    nowMs: input.nowMs ?? NOW,
  });
  return estimate!;
}

const one = (server: ServerProvider = codex({})): EnvironmentProviders[] => [
  { environmentId: ENV_A, providers: [server] },
];

describe("calibration from one account", () => {
  it("calibrates the weekly window and verifies the missing 5-hour window", () => {
    const estimate = run({ environments: one(), daily: settledA() });
    expect(estimate.rates.weekly).toMatchObject({ basis: "calibrated", observedAtMs: NOW });
    expect(estimate.rates.weekly.usdPerWindow).toBeCloseTo(550 / 0.55);
    expect(estimate.rates.session).toEqual({ basis: "noLimit", usdPerWindow: null });
    expect(estimate.account).toBe(accountIdentity(codex({})));
  });

  it("keeps the reading's own time when the cost data runs a little past it", () => {
    // Read 5 minutes ago; today's $50 spreads over the 12 hours the data covers.
    const estimate = run({
      environments: one(codex({ checkedAtMs: NOW - 5 * MINUTE })),
      daily: settledA(),
    });
    expect(estimate.rates.weekly.observedAtMs).toBe(NOW - 5 * MINUTE);
    expect(estimate.rates.weekly.usdPerWindow).toBeCloseTo(
      (500 + 50 * ((12 * 60 - 5) / (12 * 60))) / 0.55,
    );
    expect(rememberCalibrations({}, [estimate], NOW).codex?.weekly?.at).toBe(NOW - 5 * MINUTE);
  });
});

describe("retained and stale readings", () => {
  it("never calibrates a reading retained after a failed probe, even as costs grow", () => {
    for (const perDay of [WEEK, [...WEEK.slice(0, 5), 150]]) {
      const estimate = run({
        environments: one(codex({ probeFailed: true, windows: [weekly(20)] })),
        daily: [status(ENV_A, summary(ENV_A, perDay))],
      });
      expect(estimate.rates.weekly).toMatchObject({ basis: "public", blocked: "probeFailed" });
      // Nor does it prove the 5-hour limit is gone.
      expect(estimate.rates.session.basis).toBe("public");
      expect(rememberCalibrations({}, [estimate], NOW)).toEqual({});
    }
  });

  it("refuses a reading older than the freshness bound", () => {
    const estimate = run({
      environments: one(codex({ checkedAtMs: NOW - 20 * MINUTE })),
      daily: settledA(),
    });
    expect(estimate.rates.weekly).toMatchObject({ basis: "public", blocked: "stale" });
  });
});

describe("account scoping", () => {
  const twoAccounts: EnvironmentProviders[] = [
    { environmentId: ENV_A, providers: [codex({})] },
    { environmentId: ENV_B, providers: [codex({ email: "b@example.com" })] },
  ];
  const bothAnswered = () => [
    status(ENV_A, summary(ENV_A, WEEK)),
    status(ENV_B, summary(ENV_B, [70, 70, 70, 70, 70, 70])),
  ];

  it("counts only the observed account's cost when another account is not selected", () => {
    const estimate = run({
      environments: twoAccounts,
      daily: bothAnswered(),
      selected: new Set([ENV_A]),
    });
    expect(estimate.rates.weekly.usdPerWindow).toBeCloseTo(550 / 0.55);
  });

  it("falls back when the selection spans two accounts", () => {
    const remembered = rememberCalibrations(
      {},
      [run({ environments: one(), daily: settledA() })],
      NOW,
    );
    const estimate = run({ environments: twoAccounts, daily: bothAnswered(), remembered });
    expect(estimate.account).toBeNull();
    expect(estimate.rates.weekly).toMatchObject({ basis: "public", blocked: "mixedAccounts" });
  });

  it("blocks calibration when another environment's usage cannot be attributed", () => {
    const estimate = run({
      environments: [
        { environmentId: ENV_A, providers: [codex({})] },
        { environmentId: ENV_B, providers: [codex({ email: null })] },
      ],
      daily: bothAnswered(),
      selected: new Set([ENV_A]),
    });
    expect(estimate.rates.weekly).toMatchObject({ basis: "public", blocked: "otherAccounts" });
  });

  it("keeps a signed-out instance out of the account but blocks the history it may own", () => {
    const signedOut = {
      ...codex({ email: null, instanceId: "codex-2" }),
      auth: { status: "unauthenticated" },
    } as unknown as ServerProvider;
    const estimate = run({
      environments: [{ environmentId: ENV_A, providers: [codex({}), signedOut] }],
      daily: settledA(),
    });
    expect(estimate.account).toBe(accountIdentity(codex({})));
    expect(estimate.rates.weekly).toMatchObject({
      basis: "public",
      blocked: "unattributedHistory",
    });
    expect(rememberCalibrations({}, [estimate], NOW)).toEqual({});
  });

  it("adds the same account's cost from every environment", () => {
    const estimate = run({
      environments: [
        { environmentId: ENV_A, providers: [codex({})] },
        { environmentId: ENV_B, providers: [codex({ checkedAtMs: NOW - HOUR })] },
      ],
      daily: [status(ENV_A, summary(ENV_A, WEEK)), status(ENV_B, summary(ENV_B, WEEK))],
    });
    expect(estimate.rates.weekly.usdPerWindow).toBeCloseTo(1100 / 0.55);
  });

  it("does not reuse a remembered figure after switching to another account on the same plan", () => {
    const remembered = rememberCalibrations(
      {},
      [run({ environments: one(), daily: settledA() })],
      NOW,
    );
    // Account b reads 3%, too thin to calibrate.
    const switched = run({
      environments: one(codex({ email: "b@example.com", windows: [weekly(3)] })),
      daily: settledA(),
      remembered,
      nowMs: NOW + HOUR,
    });
    expect(switched.rates.weekly).toMatchObject({ basis: "public", usdPerWindow: 700 });
    // The original account still gets it back.
    const back = run({
      environments: one(codex({ windows: [weekly(3)] })),
      daily: settledA(),
      remembered,
      nowMs: NOW + HOUR,
    });
    expect(back.rates.weekly).toMatchObject({ basis: "remembered" });
  });
});

describe("coverage lifecycle", () => {
  const sameAccountTwice: EnvironmentProviders[] = [
    { environmentId: ENV_A, providers: [codex({})] },
    { environmentId: ENV_B, providers: [codex({ checkedAtMs: NOW - HOUR })] },
  ];

  it("waits for a second environment of the same account, then calibrates on both", () => {
    const staggered = run({
      environments: sameAccountTwice,
      daily: [status(ENV_A, summary(ENV_A, WEEK)), status(ENV_B, null)],
    });
    expect(staggered.rates.weekly).toMatchObject({ basis: "public", blocked: "incomplete" });
    expect(rememberCalibrations({}, [staggered], NOW)).toEqual({});
    const settled = run({
      environments: sameAccountTwice,
      daily: [status(ENV_A, summary(ENV_A, WEEK)), status(ENV_B, summary(ENV_B, WEEK))],
    });
    expect(settled.rates.weekly.usdPerWindow).toBeCloseTo(1100 / 0.55);
  });

  it.each([
    ["a scan still refreshing", status(ENV_A, summary(ENV_A, WEEK, { refreshing: true }))],
    ["a partial source", status(ENV_A, summary(ENV_A, WEEK, { status: "partial" }))],
    ["a failed source", status(ENV_A, summary(ENV_A, WEEK, { status: "failed" }))],
    ["a query refetching", status(ENV_A, summary(ENV_A, WEEK), { isPending: true })],
    ["an errored query", status(ENV_A, null, { isPending: false, error: "failed" })],
    [
      "an incompatible server",
      status(ENV_A, summary(ENV_A, WEEK, { contractVersion: USAGE_CONTRACT_VERSION + 1 })),
    ],
  ])("does not calibrate from %s", (_label, answer) => {
    const estimate = run({ environments: one(), daily: [answer] });
    expect(estimate.rates.weekly).toMatchObject({ basis: "public", blocked: "incomplete" });
  });

  it("still calibrates from usable daily history while hourly history is unavailable", () => {
    const estimate = run({
      environments: one(),
      daily: settledA(),
      hourly: [status(ENV_A, null)],
    });
    expect(estimate.rates.weekly.basis).toBe("calibrated");
  });

  it("calibrates the 5-hour window from daily history when hourly is still loading", () => {
    const session: ServerProviderUsageWindow = {
      id: "session",
      kind: "session",
      label: "5h",
      usedPercent: 50,
      resetsAt: iso(NOW + 3 * HOUR),
      windowDurationMins: 300,
    };
    const plus = codex({ label: "ChatGPT Plus Subscription", windows: [weekly(55), session] });
    const estimate = run({
      environments: one(plus),
      daily: [status(ENV_A, summary(ENV_A, [0, 0, 0, 0, 0, 12]))],
      hourly: [status(ENV_A, null)],
    });
    // Today's $12 over 12 hours: the window's last 2 hours hold $2, at 50% → $4.
    expect(estimate.rates.session.usdPerWindow).toBeCloseTo(4);
    expect(estimate.rates.session.basis).toBe("calibrated");
  });
});

describe("refresh on the same local day", () => {
  it("does not pair a fresh limit reading with cached cost from before it", () => {
    // The daily key is unchanged all day; its cached answer was read 30 minutes ago.
    const cached = [status(ENV_A, summary(ENV_A, WEEK, { readAtMs: NOW - 30 * MINUTE }))];
    const beforeRefresh = run({
      environments: one(codex({ windows: [weekly(60)] })),
      daily: cached,
    });
    expect(beforeRefresh.rates.weekly).toMatchObject({ basis: "public", blocked: "incomplete" });
    expect(rememberCalibrations({}, [beforeRefresh], NOW)).toEqual({});
    // Once the refresh re-reads the costs, both describe the same moment.
    const afterRefresh = run({
      environments: one(codex({ windows: [weekly(60)] })),
      daily: [status(ENV_A, summary(ENV_A, [100, 100, 100, 100, 100, 100]))],
    });
    expect(afterRefresh.rates.weekly.usdPerWindow).toBeCloseTo(600 / 0.6);
  });
});

describe("remembered storage", () => {
  function memoryStorage(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial));
    return {
      values,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    };
  }
  const entry = {
    usdPerWindow: 700,
    usedPercent: 40,
    at: NOW - HOUR,
    planId: "codex-pro-200",
    account: "email:codex:x",
  };

  it("never reads unscoped v1 values and removes them on the next write", () => {
    const storage = memoryStorage({
      "t3code:usage-limit-calibration:v1": JSON.stringify({
        codex: { weekly: { usdPerWindow: 700, usedPercent: 40, at: NOW, planId: "codex-pro-200" } },
      }),
    });
    expect(readRemembered(storage)).toEqual({});
    writeRemembered(storage, { codex: { weekly: entry } });
    expect(storage.values.has("t3code:usage-limit-calibration:v1")).toBe(false);
    expect(readRemembered(storage)).toEqual({ codex: { weekly: entry } });
  });

  it("survives corrupt, partly invalid and blocked storage", () => {
    expect(readRemembered(memoryStorage({ [CALIBRATION_KEY]: "{not json" }))).toEqual({});
    expect(
      readRemembered(
        memoryStorage({
          [CALIBRATION_KEY]: JSON.stringify({
            codex: { weekly: entry, session: { ...entry, usdPerWindow: -1 } },
          }),
        }),
      ),
    ).toEqual({ codex: { weekly: entry } });
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readRemembered(blocked)).toEqual({});
    expect(() => writeRemembered(blocked, { codex: { weekly: entry } })).not.toThrow();
    expect(readRemembered(undefined)).toEqual({});
  });
});

/** Adds a second transcript home of the same provider to one environment's answer. */
function withHome(
  answer: UsageSummary,
  home: string,
  perDay: readonly number[],
  sourceStatus: "ok" | "missing" = "ok",
): UsageSummary {
  const template = answer.sources[0]!;
  return {
    ...answer,
    buckets: [
      ...answer.buckets,
      ...perDay.map((costUsd, index) => ({
        ...answer.buckets[0]!,
        day: `2026-11-${17 + index}` as UsageSummary["sinceDay"],
        sourcePath: home,
        costUsd,
      })),
    ],
    sources: [
      ...answer.sources,
      {
        ...template,
        fingerprint: { ...template.fingerprint, resolvedHomePath: home },
        status: sourceStatus,
      },
    ],
  };
}

describe("transcript ownership", () => {
  const disabledB = {
    ...codex({ email: "b@example.com", instanceId: "codex-b" }),
    enabled: false,
  } as ServerProvider;

  it("never counts a disabled account's separate home toward the signed-in account", () => {
    // A reads 55% with $550 of its own; B's home holds $600 more this week, or nothing yet.
    for (const bWeek of [[100, 100, 100, 100, 100, 100], []]) {
      const estimate = run({
        environments: [{ environmentId: ENV_A, providers: [codex({}), disabledB] }],
        daily: [status(ENV_A, withHome(summary(ENV_A, WEEK), "/home/b/.codex", bWeek))],
      });
      expect(estimate.rates.weekly).toMatchObject({
        basis: "public",
        blocked: "unattributedHistory",
      });
      expect(rememberCalibrations({}, [estimate], NOW)).toEqual({});
    }
  });

  it("blocks a default home kept after the instance moved, but not an absent one", () => {
    const kept = run({
      environments: one(),
      daily: [status(ENV_A, withHome(summary(ENV_A, WEEK), "/home/env-a/.codex-default", [40]))],
    });
    expect(kept.rates.weekly).toMatchObject({ basis: "public", blocked: "unattributedHistory" });
    const absent = run({
      environments: one(),
      daily: [
        status(ENV_A, withHome(summary(ENV_A, WEEK), "/home/env-a/.codex-default", [], "missing")),
      ],
    });
    expect(absent.rates.weekly.usdPerWindow).toBeCloseTo(550 / 0.55);
  });

  it("does not calibrate a window that opened before an account switch in the same home", () => {
    const earlier = Date.parse("2026-11-10T00:00:00.000Z");
    const seenAsB = updateAccountLedger({}, one(codex({ email: "b@example.com" })), earlier);
    // The home now signs in as A; its history this week may still be B's.
    const switched = updateAccountLedger(seenAsB, one(), NOW - HOUR);
    expect(switched).not.toBe(seenAsB);
    const estimate = run({ environments: one(), daily: settledA(), accounts: switched });
    expect(estimate.rates.weekly).toMatchObject({ basis: "public", blocked: "accountHistory" });
    expect(rememberCalibrations({}, [estimate], NOW)).toEqual({});
    // First sight is no proof either, and an unrecorded instance never calibrates.
    const unconfirmed: AccountLedger[] = [updateAccountLedger({}, one(), NOW - HOUR), {}];
    for (const accounts of unconfirmed) {
      expect(run({ environments: one(), daily: settledA(), accounts }).rates.weekly).toMatchObject(
        { blocked: "accountHistory" },
      );
    }
    // Seen as A since before the window opened on 2026-11-17, it calibrates and keeps its stamp.
    const steady = updateAccountLedger({}, one(), earlier);
    expect(updateAccountLedger(steady, one(), NOW)).toBe(steady);
    expect(run({ environments: one(), daily: settledA(), accounts: steady }).rates.weekly.basis).toBe(
      "calibrated",
    );
  });

  it("stores the account ledger and survives corrupt or blocked storage", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
    const ledger = updateAccountLedger({}, one(), NOW);
    writeAccountLedger(storage, ledger);
    expect(readAccountLedger(storage)).toEqual(ledger);
    values.set(
      ACCOUNT_LEDGER_KEY,
      JSON.stringify({ good: { account: "a", sinceMs: 1 }, bad: { account: "", sinceMs: -1 } }),
    );
    expect(readAccountLedger(storage)).toEqual({ good: { account: "a", sinceMs: 1 } });
    values.set(ACCOUNT_LEDGER_KEY, "{not json");
    expect(readAccountLedger(storage)).toEqual({});
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readAccountLedger(blocked)).toEqual({});
    expect(() => writeAccountLedger(blocked, ledger)).not.toThrow();
  });
});

describe("environments that answer with no cost", () => {
  const sameAccountTwice: EnvironmentProviders[] = [
    { environmentId: ENV_A, providers: [codex({})] },
    { environmentId: ENV_B, providers: [codex({ checkedAtMs: NOW - HOUR })] },
  ];

  it.each([
    ["still refreshing", { refreshing: true }],
    ["partial", { status: "partial" as const }],
    ["failed", { status: "failed" as const }],
    ["from an incompatible server", { contractVersion: USAGE_CONTRACT_VERSION + 1 }],
  ])("waits for an empty answer %s, then stores only the completed figure", (_label, options) => {
    const intermediate = run({
      environments: sameAccountTwice,
      daily: [
        status(ENV_A, summary(ENV_A, WEEK)),
        status(ENV_B, summary(ENV_B, [], options), { isPending: false }),
      ],
    });
    expect(intermediate.rates.weekly).toMatchObject({ basis: "public", blocked: "incomplete" });
    expect(rememberCalibrations({}, [intermediate], NOW)).toEqual({});
    // B's scan finishes with its own $550: the figure doubles, and only that one is stored.
    const completed = run({
      environments: sameAccountTwice,
      daily: [status(ENV_A, summary(ENV_A, WEEK)), status(ENV_B, summary(ENV_B, WEEK))],
    });
    expect(completed.rates.weekly.usdPerWindow).toBeCloseTo(1100 / 0.55);
    expect(rememberCalibrations({}, [completed], NOW).codex?.weekly?.usdPerWindow).toBeCloseTo(
      1100 / 0.55,
    );
  });

  it("still counts a settled empty answer as zero", () => {
    const estimate = run({
      environments: sameAccountTwice,
      daily: [status(ENV_A, summary(ENV_A, WEEK)), status(ENV_B, summary(ENV_B, []))],
    });
    expect(estimate.rates.weekly.usdPerWindow).toBeCloseTo(550 / 0.55);
  });
});

describe("mixed accounts never read as no limit", () => {
  const plusSession: ServerProviderUsageWindow = {
    id: "session",
    kind: "session",
    label: "5h",
    usedPercent: 30,
    resetsAt: iso(NOW + 3 * HOUR),
    windowDurationMins: 300,
  };
  const plus = (checkedAtMs: number) =>
    codex({
      email: "b@example.com",
      label: "ChatGPT Plus Subscription",
      windows: [weekly(40), plusSession],
      checkedAtMs,
    });

  it.each([
    ["Pro listed first and newer", codex({}), plus(NOW - MINUTE), false],
    ["Plus listed first, Pro newer", codex({}), plus(NOW - MINUTE), true],
    ["Plus newer", codex({ checkedAtMs: NOW - MINUTE }), plus(NOW), false],
  ])("with %s", (_label, pro, plusServer, plusFirst) => {
    const entries: EnvironmentProviders[] = [
      { environmentId: ENV_A, providers: [pro] },
      { environmentId: ENV_B, providers: [plusServer] },
    ];
    const estimate = run({
      environments: plusFirst ? entries.toReversed() : entries,
      daily: [status(ENV_A, summary(ENV_A, WEEK)), status(ENV_B, summary(ENV_B, WEEK))],
    });
    expect(estimate.account).toBeNull();
    expect(estimate.rates.session.basis).not.toBe("noLimit");
    expect(estimate.rates.session).toMatchObject({ blocked: "mixedAccounts" });
    const value: LimitEstimates = {
      measure: "session",
      byProvider: new Map([["codex", estimate]]),
      rates: new Map(),
      onMeasureChange: () => {},
      onPlanChange: () => {},
    };
    expect(missingShareLabel(value, "codex")).not.toBe("No limit");
    const text = rateBasisText(estimate.rates.session, "session", estimate);
    expect(text).not.toContain("No 5-hour limit");
    expect(text).toContain("more than one account");
  });
});
