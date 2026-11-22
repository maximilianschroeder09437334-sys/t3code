import type { LegendListRef } from "@legendapp/list/react";
import { useEffect, useRef, type RefObject } from "react";

import { resolveTimelineItemReveal, type MessagesTimelineRow } from "./MessagesTimeline.logic";

const ITEM_REVEAL_VIEW_OFFSET = 96;

/** Scrolls an `?item=` link's row into view once per list and item, paging in history first. */
export function useTimelineItemReveal(input: {
  readonly itemId: string | null;
  readonly listKey: string;
  readonly rows: ReadonlyArray<MessagesTimelineRow>;
  readonly entries: ReadonlyArray<{ readonly id: string }>;
  readonly listReady: boolean;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly historyControls?:
    | {
        readonly hasMoreHistory: boolean;
        readonly loading: boolean;
        readonly error: string | null;
        readonly onLoadEarlier: (throughEntryId?: string) => void;
      }
    | undefined;
}) {
  const { itemId, listKey, rows, entries, listReady, listRef, historyControls } = input;
  const revealedRef = useRef<string | null>(null);
  const requestedPagesRef = useRef<{ key: string | null; cursors: Set<string> }>({
    key: null,
    cursors: new Set(),
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the list to an ?item= link's row after commit, paging in earlier history until it loads
  useEffect(() => {
    if (itemId === null) return;
    const key = `${listKey}\u0000${itemId}`;
    if (revealedRef.current === key) return;
    const step = resolveTimelineItemReveal({
      itemId,
      rows,
      entries,
      listReady,
      history: historyControls,
    });
    if (step.kind === "scroll") {
      revealedRef.current = key;
      void listRef.current?.scrollToIndex({
        index: step.index,
        animated: false,
        viewOffset: ITEM_REVEAL_VIEW_OFFSET,
      });
      return;
    }
    if (step.kind !== "load-earlier" || historyControls === undefined) return;
    if (requestedPagesRef.current.key !== key) {
      requestedPagesRef.current = { key, cursors: new Set() };
    }
    const cursor = entries[0]?.id ?? "first";
    if (requestedPagesRef.current.cursors.has(cursor)) return;
    requestedPagesRef.current.cursors.add(cursor);
    historyControls.onLoadEarlier(itemId);
  }, [itemId, listKey, rows, entries, listReady, listRef, historyControls]);
}
