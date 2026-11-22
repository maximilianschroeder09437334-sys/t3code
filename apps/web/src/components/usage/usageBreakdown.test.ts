import type { ModelTotals } from "@t3tools/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";

import {
  cacheHitRate,
  costPerMillionTokens,
  costTypeSegments,
  limitShareSegments,
} from "./usageBreakdown";

const model = (
  name: string,
  totalTokens: number,
  costUsd: number,
  overrides: Partial<ModelTotals> = {},
): ModelTotals => ({
  model: name,
  provider: "codex",
  costUsd,
  totalTokens,
  tokens: {
    uncachedInputTokens: totalTokens,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  },
  records: 1,
  unpricedRecords: 0,
  unpricedTokens: 0,
  costShare: 0,
  tokenShare: 0,
  ...overrides,
});

describe("model rates", () => {
  it("counts cache writes as misses and leaves unpriced tokens out of $/1M", () => {
    const mixed = model("mixed", 4_000_000, 6, {
      tokens: {
        uncachedInputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        cacheCreationTokens: 2_000_000,
        outputTokens: 0,
        reasoningTokens: 0,
      },
      records: 4,
      unpricedRecords: 1,
      unpricedTokens: 1_000_000,
    });

    expect(cacheHitRate(mixed)).toBe(0.25);
    expect(costPerMillionTokens(mixed)).toBe(2);
    expect(costPerMillionTokens({ ...mixed, unpricedRecords: 4 })).toBeNull();
  });
});

describe("limitShareSegments", () => {
  it("converts one provider's cost into shares of that provider's own window", () => {
    const claude = costTypeSegments({
      input: 100,
      cacheRead: 50,
      cacheWrite: 0,
      output: 250,
      unsplit: 0,
    });
    const codex = costTypeSegments({
      input: 10,
      cacheRead: 5,
      cacheWrite: 0,
      output: 20,
      unsplit: 0,
    });
    // Equal input cost fills each provider's own pool by a different share, and never a sum.
    const claudeShares = new Map(
      limitShareSegments(claude, 1000).map((segment) => [segment.label, segment.value]),
    );
    const codexShares = new Map(
      limitShareSegments(codex, 100).map((segment) => [segment.label, segment.value]),
    );
    expect(claudeShares.get("Input")).toBeCloseTo(0.1);
    expect(codexShares.get("Input")).toBeCloseTo(0.1);
    expect(claudeShares.get("Output")).toBeCloseTo(0.25);
    expect(codexShares.get("Output")).toBeCloseTo(0.2);
    const sameCost = costTypeSegments({
      input: 50,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      unsplit: 0,
    });
    expect(limitShareSegments(sameCost, 1000)[0]?.value).toBeCloseTo(0.05);
    expect(limitShareSegments(sameCost, 100)[0]?.value).toBeCloseTo(0.5);
    expect(limitShareSegments(claude, 0)).toEqual([]);
  });
});
