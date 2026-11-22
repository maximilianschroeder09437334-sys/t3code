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
  it("adds each provider's cost as a share of that provider's own window", () => {
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
    const segments = limitShareSegments([
      { segments: claude, usdPerWindow: 1000 },
      { segments: codex, usdPerWindow: 100 },
    ]);
    const byLabel = new Map(segments.map((segment) => [segment.label, segment.value]));
    expect(byLabel.get("Input")).toBeCloseTo(0.1 + 0.1);
    expect(byLabel.get("Output")).toBeCloseTo(0.25 + 0.2);
    expect(limitShareSegments([])).toEqual([]);
  });
});
