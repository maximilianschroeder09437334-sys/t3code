import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ThreadId, type ActivityEvent } from "@t3tools/contracts";
import { dailySummary, eventLine, topicProperties } from "./NotionMapping.ts";

const event = {
  sequence: 1,
  id: "event-1",
  at: "2026-11-17T12:00:00.000Z",
  kind: "done",
  projectId: ProjectId.make("project"),
  threadId: ThreadId.make("thread"),
  featureKey: "relay",
  summary: "Finished",
  next: "Review",
} satisfies ActivityEvent;
describe("Notion mapping", () => {
  it("maps each target's exact property and option names", () => {
    expect(topicProperties(event, "t3")).toHaveProperty("Last step");
    expect(topicProperties(event, "t3").Type.select.name).toBe("Topic entry");
    expect(topicProperties(event, "pipeline")).toHaveProperty("last step");
    expect(topicProperties(event, "pipeline").Type.select.name).toBe("Topic Entry");
  });
  it("builds deterministic event markers and rollups", () => {
    expect(eventLine(event)).toContain("[t3-event:event-1]");
    expect(dailySummary([event, event])).toBe("done: Finished\ndone: Finished");
  });
});
