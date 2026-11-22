import { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { Route as ThreadRoute } from "../../routes/_chat.$environmentId.$threadId";
import { waitTargetRoute } from "../WaitingOn.logic";
import {
  resolveTimelineItemReveal,
  timelineRowIndexForItem,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";

const rows = [
  { kind: "message", id: "message-1" },
  { kind: "work", id: "group:details", groupedEntries: [{ id: "item-grouped" }] },
  { kind: "work-live", id: "live", entry: { id: "item-live" }, groupedEntries: [] },
  { kind: "turn-fold", id: "fold", deferredWorkItemIds: ["item-folded"] },
  { kind: "event", id: "item-own-row" },
] as unknown as MessagesTimelineRow[];
const entries = ["message-1", "item-grouped", "item-live", "item-folded", "item-own-row"].map(
  (id) => ({ id }),
);
const history = { hasMoreHistory: true, loading: false, error: null };

describe("timelineRowIndexForItem", () => {
  it("finds the row that shows an item", () => {
    expect(timelineRowIndexForItem(rows, "item-own-row")).toBe(4);
    expect(timelineRowIndexForItem(rows, "item-grouped")).toBe(1);
    expect(timelineRowIndexForItem(rows, "item-live")).toBe(2);
    expect(timelineRowIndexForItem(rows, "item-folded")).toBe(3);
    expect(timelineRowIndexForItem(rows, "missing")).toBe(-1);
  });
});

describe("resolveTimelineItemReveal", () => {
  it("scrolls to a loaded row once the list is ready", () => {
    const input = { itemId: "item-grouped", rows, entries, history };
    expect(resolveTimelineItemReveal({ ...input, listReady: false })).toEqual({ kind: "none" });
    expect(resolveTimelineItemReveal({ ...input, listReady: true })).toEqual({
      kind: "scroll",
      index: 1,
    });
  });

  it("pages in earlier history for an item that is not loaded yet", () => {
    const input = { itemId: "older", rows, entries, listReady: true };
    expect(resolveTimelineItemReveal({ ...input, history })).toEqual({ kind: "load-earlier" });
    expect(resolveTimelineItemReveal({ ...input, history: { ...history, loading: true } })).toEqual(
      { kind: "none" },
    );
    expect(
      resolveTimelineItemReveal({ ...input, history: { ...history, hasMoreHistory: false } }),
    ).toEqual({ kind: "none" });
    expect(
      resolveTimelineItemReveal({ ...input, history: { ...history, error: "offline" } }),
    ).toEqual({ kind: "none" });
  });

  it("does nothing without an item, or for a loaded item with no row", () => {
    expect(
      resolveTimelineItemReveal({ itemId: null, rows, entries, listReady: true, history }),
    ).toEqual({ kind: "none" });
    expect(
      resolveTimelineItemReveal({
        itemId: "hidden",
        rows,
        entries: [...entries, { id: "hidden" }],
        listReady: true,
        history,
      }),
    ).toEqual({ kind: "none" });
  });

  it("carries a subagent's Open from the wait target through the route to its row", () => {
    const env = EnvironmentId.make("environment-test");
    const waiterId = ThreadId.make("waiter");
    const route = waitTargetRoute(
      { environmentId: env, threadId: waiterId },
      {
        title: "Explore",
        environmentId: env,
        threadId: null,
        waiterThreadId: waiterId,
        itemId: TurnItemId.make("item-live"),
        source: "subagent",
        kind: "subagent",
        state: "live",
      },
    );
    expect(route).toEqual({ environmentId: env, threadId: waiterId, item: "item-live" });
    const validateSearch = ThreadRoute.options.validateSearch as (raw: Record<string, unknown>) => {
      item?: string;
    };
    const search = validateSearch({
      item: route !== null && "item" in route ? route.item : undefined,
    });
    expect(search).toEqual({ item: "item-live" });
    expect(validateSearch({ item: 7 })).toEqual({});
    expect(
      resolveTimelineItemReveal({
        itemId: search.item ?? null,
        rows,
        entries,
        listReady: true,
        history,
      }),
    ).toEqual({ kind: "scroll", index: 2 });
  });
});
