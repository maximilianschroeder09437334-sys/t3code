import type { ActivityEvent } from "@t3tools/contracts";

export type LogTarget = "t3" | "pipeline";
const text = (value: string) => [{ type: "text", text: { content: value.slice(0, 2000) } }];
const rich = (value: string) => ({ rich_text: text(value) });

export function topicProperties(event: ActivityEvent, target: LogTarget) {
  return {
    Name: { title: text(event.featureTitle ?? event.featureKey ?? event.summary) },
    Type: { select: { name: target === "t3" ? "Topic entry" : "Topic Entry" } },
    Summary: rich(event.summary),
    [target === "t3" ? "Last step" : "last step"]: rich(event.summary),
    "Next steps": rich(event.next ?? ""),
    Date: { date: { start: event.at.slice(0, 10) } },
  };
}

export function eventLine(event: ActivityEvent) {
  return `[t3-event:${event.id}] ${event.at} ${event.kind}: ${event.summary}`;
}

export function dailySummary(events: readonly ActivityEvent[]) {
  return events.map((event) => `${event.kind}: ${event.summary}`).join("\n");
}
