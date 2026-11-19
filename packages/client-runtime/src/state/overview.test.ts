import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId, type ActivityEvent } from "@t3tools/contracts";
import { deriveOverviewFeed, formatOverviewElapsed, formatOverviewContext } from "./overview.ts";

const event = (sequence: number, at: string): ActivityEvent => ({
  sequence,
  id: `event-${sequence}`,
  at,
  kind: "progress",
  projectId: ProjectId.make("project:test"),
  threadId: ThreadId.make("thread:test"),
  summary: "Progress",
});

describe("overview feed", () => {
  it("deduplicates history and live events without mixing environment sequences", () => {
    const first = EnvironmentId.make("environment:first");
    const second = EnvironmentId.make("environment:second");
    const a = event(2, "2026-11-19T10:00:00.000Z");
    const b = event(3, "2026-11-19T11:00:00.000Z");
    const result = deriveOverviewFeed([
      {
        environmentId: first,
        checkIn: { seenSequence: 1, seenAt: "2026-11-19T09:00:00.000Z" },
        unseen: [a],
        live: [a, b],
        truncated: false,
      },
      { environmentId: second, checkIn: null, unseen: [a], live: [], truncated: true },
    ]);
    expect(result.events.map((item) => [item.environmentId, item.sequence])).toEqual([
      [first, 3],
      [first, 2],
      [second, 2],
    ]);
    expect(result.truncated).toBe(true);
    expect(result.lastSeenAt).toBeNull();
  });
  it("leaves unknown measurements unknown", () => {
    expect(formatOverviewElapsed(null, 0)).toBeNull();
    expect(formatOverviewElapsed("2026-11-19T10:00:00.000Z", 0)).toBeNull();
    expect(formatOverviewContext({ usedTokens: 84000, maxTokens: null, usedPercent: null })).toBe(
      "84k",
    );
  });
});
