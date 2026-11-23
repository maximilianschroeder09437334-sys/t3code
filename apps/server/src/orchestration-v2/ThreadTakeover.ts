// @effect-diagnostics nodeBuiltinImport:off - a synchronous hash keeps admission a pure function.
import * as NodeCrypto from "node:crypto";

import {
  isListedThreadLineage,
  type OrchestrationV2AppThread,
  type OrchestratorMcpThreadTakeoverResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";

export type TakeoverRejection =
  | { readonly code: "takeover_unproven"; readonly message: string }
  | { readonly code: "takeover_invalid"; readonly message: string }
  | { readonly code: "takeover_conflict"; readonly message: string };

export type TakeoverAdmission =
  | { readonly ok: true; readonly transferId: string }
  | ({ readonly ok: false } & TakeoverRejection);

/** Stable across retries and restarts: one launch of S by P names one transfer. */
export const takeoverTransferId = (
  predecessorThreadId: ThreadId,
  successorThreadId: ThreadId,
  launchCommandId: string,
) =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify([predecessorThreadId, successorThreadId, launchCommandId]))
    .digest("hex");

type ThreadRelations = Pick<
  OrchestrationV2AppThread,
  "id" | "lineage" | "archivedAt" | "deletedAt" | "launchedBy" | "continuedBy" | "continues"
>;

const rejected = (code: TakeoverRejection["code"], message: string): TakeoverAdmission => ({
  ok: false,
  code,
  message,
});

/**
 * A live `attempting` record of another successor blocks; an expired one reads as `timed_out`.
 * `predecessorUpstream` is the predecessor's `continues` chain, nearest first.
 */
export const admitTakeover = (input: {
  readonly predecessor: ThreadRelations;
  readonly successor: ThreadRelations;
  readonly now: DateTime.Utc;
  readonly predecessorUpstream: ReadonlyArray<ThreadId>;
}): TakeoverAdmission => {
  const { predecessor, successor, now } = input;
  if (successor.launchedBy === undefined || successor.launchedBy.threadId !== predecessor.id)
    return rejected(
      "takeover_unproven",
      "This thread was not launched by that thread with t3_thread_launch, so it cannot take over its work.",
    );
  if (successor.id === predecessor.id)
    return rejected("takeover_invalid", "A thread cannot take over itself.");
  for (const thread of [predecessor, successor]) {
    if (!isListedThreadLineage(thread.lineage))
      return rejected(
        "takeover_invalid",
        `Thread ${thread.id} is a subagent or side chat; only top-level threads take over.`,
      );
    if (thread.archivedAt !== null || thread.deletedAt !== null)
      return rejected("takeover_invalid", `Thread ${thread.id} is archived or deleted.`);
  }
  if (successor.continues !== undefined && successor.continues.threadId !== predecessor.id)
    return rejected("takeover_invalid", "This thread already took over another thread.");
  const continuedBy = predecessor.continuedBy;
  if (
    continuedBy !== undefined &&
    continuedBy.threadId !== successor.id &&
    continuedBy.state !== "timed_out" &&
    !(
      continuedBy.state === "attempting" &&
      DateTime.toEpochMillis(continuedBy.deadlineAt) < DateTime.toEpochMillis(now)
    )
  )
    return rejected(
      "takeover_conflict",
      `Thread ${continuedBy.threadId} ${continuedBy.state === "effective" ? "already took over" : "is taking over"} that thread.`,
    );
  if (input.predecessorUpstream.includes(successor.id))
    return rejected("takeover_invalid", "That thread continues this one; takeovers cannot cycle.");
  return {
    ok: true,
    transferId: takeoverTransferId(predecessor.id, successor.id, successor.launchedBy.commandId),
  };
};

/** Bounds of one synchronous takeover attempt. The deadline stays below the MCP call timeout. */
export interface ThreadTakeoverSettingsValue {
  readonly deadlineMs: number;
  /** After the deadline: how long to wait for the predecessor to record `timed_out`. */
  readonly timeoutWriteMs: number;
  /** Jittered pause, holding no lock, after a try-lock miss. */
  readonly retryPauseMs: readonly [min: number, max: number];
}

export const ThreadTakeoverSettings = Context.Reference<ThreadTakeoverSettingsValue>(
  "t3/orchestration-v2/ThreadTakeoverSettings",
  { defaultValue: () => ({ deadlineMs: 30_000, timeoutWriteMs: 2_000, retryPauseMs: [50, 400] }) },
);

export type ThreadTakeoverFailureCode =
  | TakeoverRejection["code"]
  | "takeover_in_progress"
  | "takeover_timeout"
  | "takeover_successor_not_running";

export type ThreadTakeoverOutcome =
  | { readonly ok: true; readonly result: OrchestratorMcpThreadTakeoverResult }
  | { readonly ok: false; readonly code: ThreadTakeoverFailureCode; readonly message: string };
