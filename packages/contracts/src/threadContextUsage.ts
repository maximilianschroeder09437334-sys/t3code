import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, ThreadId } from "./baseSchemas.ts";

/** The context a thread's active conversation holds, as its provider last reported it. */
export const ThreadContextUsage = Schema.Struct({
  threadId: ThreadId,
  usedTokens: NonNegativeInt,
  /** Null when the provider reported no context window; clients show the size as unknown. */
  maxTokens: Schema.NullOr(PositiveInt),
  updatedAt: IsoDateTime,
});
export type ThreadContextUsage = typeof ThreadContextUsage.Type;

/** A null usage clears a previous report when the active conversation changes. */
export const ThreadContextUsageUpdate = Schema.Struct({
  threadId: ThreadId,
  usage: Schema.NullOr(ThreadContextUsage),
});
export type ThreadContextUsageUpdate = typeof ThreadContextUsageUpdate.Type;

const THREAD_CONTEXT_USAGE_MAX_THREADS = 50;

/** Streams each thread?s current usage, including unknown, then every change. */
export const ThreadContextUsageSubscribeInput = Schema.Struct({
  threadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(THREAD_CONTEXT_USAGE_MAX_THREADS)),
});
export type ThreadContextUsageSubscribeInput = typeof ThreadContextUsageSubscribeInput.Type;
