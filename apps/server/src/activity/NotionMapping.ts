import type { ActivityEvent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export type LogTarget = "t3" | "pipeline";
const text = (value: string) => [{ type: "text", text: { content: value.slice(0, 2000) } }];
const rich = (value: string) => ({ rich_text: text(value) });

export function isoWeek(day: string) {
  const date = DateTime.toDateUtc(DateTime.makeUnsafe(`${day}T00:00:00.000Z`));
  const weekday = (date.getUTCDay() + 6) % 7;
  const mondayMs = date.getTime() - weekday * 86400000;
  const thursday = DateTime.toDateUtc(DateTime.makeUnsafe(mondayMs + 3 * 86400000));
  const year = thursday.getUTCFullYear();
  const jan4 = DateTime.toDateUtc(DateTime.makeUnsafe(`${year}-01-04T00:00:00.000Z`));
  const firstMonday = jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86400000;
  return {
    key: `${year}-W${String(Math.floor((mondayMs - firstMonday) / 604800000) + 1).padStart(2, "0")}`,
    monday: DateTime.formatIso(DateTime.makeUnsafe(mondayMs)).slice(0, 10),
  };
}

export function periodProperties(date: string, name: string, type: string, parentId?: string) {
  return {
    Name: { title: text(name) },
    Type: { select: { name: type } },
    Date: { date: { start: date } },
    ...(parentId === undefined ? {} : { "Parent item": { relation: [{ id: parentId }] } }),
  };
}

export function topicProperties(event: ActivityEvent, target: LogTarget, day: string) {
  return {
    Name: { title: text(event.featureTitle ?? event.featureKey ?? event.summary) },
    Type: { select: { name: target === "t3" ? "Topic entry" : "Topic Entry" } },
    Summary: rich(event.summary),
    [target === "t3" ? "Last step" : "last step"]: rich(event.summary),
    "Next steps": rich(event.next ?? ""),
    Date: { date: { start: day } },
  };
}

export function eventLine(event: ActivityEvent) {
  return `[t3-event:${event.id}] ${event.at} ${event.kind}: ${event.summary}`;
}

export function dailySummary(
  counts: ReadonlyArray<{ readonly kind: string; readonly count: number }>,
) {
  const total = counts.reduce((sum, entry) => sum + entry.count, 0);
  return `${total} events: ${counts.map(({ kind, count }) => `${kind} ${count}`).join(", ")}`;
}

export function dailyProperties(
  day: string,
  counts: ReadonlyArray<{ readonly kind: string; readonly count: number }>,
  latest: ActivityEvent | undefined,
  target: LogTarget,
) {
  return {
    Name: { title: text(day) },
    Type: { select: { name: target === "t3" ? "Daily entry" : "Daily Entry" } },
    Summary: rich(dailySummary(counts)),
    [target === "t3" ? "Last step" : "last step"]: rich(latest?.summary ?? ""),
    "Next steps": rich(latest?.next ?? ""),
    Date: { date: { start: day } },
  };
}

export function roadmapStage(kind: ActivityEvent["kind"]): "Planned" | "Current" | "Done" | null {
  if (kind === "planned") return "Planned";
  if (kind === "dispatched" || kind === "progress") return "Current";
  return kind === "done" ? "Done" : null;
}

export function notionPageId(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !["app.notion.com", "www.notion.so", "notion.so"].includes(url.hostname)
    )
      return null;
    const match = url.pathname.match(
      /([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i,
    );
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}
