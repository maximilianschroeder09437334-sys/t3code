import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ThreadId, type ActivityEvent } from "@t3tools/contracts";
import {
  dailySummary,
  eventLine,
  isoWeek,
  notionPageId,
  roadmapStage,
  topicProperties,
} from "./NotionMapping.ts";

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
    expect(topicProperties(event, "t3", "2026-11-17")).toHaveProperty("Last step");
    expect(topicProperties(event, "t3", "2026-11-17").Type.select.name).toBe("Topic entry");
    expect(topicProperties(event, "pipeline", "2026-11-17")).toHaveProperty("last step");
    expect(topicProperties(event, "pipeline", "2026-11-17").Type.select.name).toBe("Topic Entry");
    expect(topicProperties(event, "t3", "2026-11-18").Date.date.start).toBe("2026-11-18");
  });
  it("builds deterministic event markers and rollups", () => {
    expect(eventLine(event)).toContain("[t3-event:event-1]");
    expect(dailySummary([{ kind: "done", count: 2 }])).toBe("2 events: done 2");
  });
  it("recognizes roadmap stages and only trusted Notion URLs", () => {
    expect(isoWeek("2021-01-01")).toEqual({ key: "2020-W53", monday: "2020-12-28" });
    expect(roadmapStage("done")).toBe("Done");
    expect(roadmapStage("blocked")).toBeNull();
    expect(notionPageId("https://app.notion.com/p/41bf6c71fa5e8176841ef5950850ac93")).toBe(
      "41bf6c71fa5e8176841ef5950850ac93",
    );
    expect(
      notionPageId("https://notion.com.evil.example/41bf6c71fa5e8176841ef5950850ac93"),
    ).toBeNull();
  });
});
