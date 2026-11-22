import {
  SUBSCRIPTION_PLANS,
  type LimitRate,
  type ProviderLimitEstimate,
} from "@t3tools/shared/usageEstimate";
import { describe, expect, it } from "vite-plus/test";

import type { LimitEstimates } from "./usageLimitEstimates";
import {
  MEASURE_HEADING,
  missingShareLabel,
  modelShareColumns,
  rateBasisText,
  shareRowDetail,
} from "./usageLimitText";

const plan = (id: string) => SUBSCRIPTION_PLANS.find((entry) => entry.id === id)!;

function estimates(session: LimitRate, weekly: LimitRate = { basis: "public", usdPerWindow: 700 }) {
  const estimate: ProviderLimitEstimate = {
    provider: "codex",
    plan: plan("codex-pro-200"),
    planSource: "detected",
    detectedPlanId: "codex-pro-200",
    account: "email:codex:a",
    rates: { weekly, session },
  };
  const value: LimitEstimates = {
    measure: "session",
    byProvider: new Map([["codex", estimate]]),
    rates: new Map(),
    onMeasureChange: () => {},
    onPlanChange: () => {},
  };
  return { value, estimate };
}

describe("missing limit states", () => {
  it("says no limit only for a verified absence", () => {
    const verified = estimates({ basis: "noLimit", usdPerWindow: null });
    expect(missingShareLabel(verified.value, "codex")).toBe("No limit");
    expect(rateBasisText(verified.estimate.rates.session, "session", verified.estimate)).toBe(
      "No 5-hour limit on this account.",
    );
    expect(shareRowDetail({ ...verified.value, measure: "weekly" }, "codex", 70)).toBe(
      "no 5-hour limit · $70.00 API",
    );
  });

  it("says unknown when no figure exists, without claiming there is no limit", () => {
    const unknown = estimates({ basis: "unknown", usdPerWindow: null, windowUnreported: true });
    expect(missingShareLabel(unknown.value, "codex")).toBe("Unknown");
    const text = rateBasisText(unknown.estimate.rates.session, "session", unknown.estimate);
    expect(text).toContain("Unknown");
    expect(text).not.toContain("No 5-hour limit");
    expect(shareRowDetail({ ...unknown.value, measure: "weekly" }, "codex", 70)).toBe(
      "5-hour unknown · $70.00 API",
    );
    // A provider without an estimate is unknown too.
    expect(missingShareLabel(unknown.value, "claude")).toBe("Unknown");
  });

  it("labels an unreported window that falls back to the public estimate", () => {
    const fallback = estimates({
      basis: "public",
      usdPerWindow: 115,
      windowUnreported: true,
      blocked: "noReading",
    });
    expect(rateBasisText(fallback.estimate.rates.session, "session", fallback.estimate)).toBe(
      "No 5-hour window reported. $115.00 API fills it, public estimate for ChatGPT Pro 200.",
    );
  });

  it("explains why the live reading did not calibrate", () => {
    const { estimate } = estimates({ basis: "public", usdPerWindow: 115 });
    const text = (blocked: NonNullable<LimitRate["blocked"]>) =>
      rateBasisText({ basis: "public", usdPerWindow: 700, blocked }, "weekly", estimate);
    expect(text("probeFailed")).toContain("The last limit check failed.");
    expect(text("stale")).toContain("too old");
    expect(text("incomplete")).toContain("Waiting for complete usage data");
    expect(text("mixedAccounts")).toContain("more than one account");
    expect(text("otherAccounts")).toContain("can't tell apart");
    // Early in a window a thin reading is normal and needs no note.
    expect(text("thin")).toBe("$700.00 API fills it, public estimate for ChatGPT Pro 200.");
  });
});

describe("model share columns", () => {
  it("puts the selected window first, the only share column a phone shows", () => {
    expect(modelShareColumns("session")).toEqual({ primary: "session", secondary: "weekly" });
    expect(modelShareColumns("weekly")).toEqual({ primary: "weekly", secondary: "session" });
    expect(MEASURE_HEADING[modelShareColumns("session").primary]).toBe("5-hour");
  });
});
