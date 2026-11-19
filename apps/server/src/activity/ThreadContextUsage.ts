import {
  ActivityLedgerError,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type ProviderThreadId,
  type ThreadContextUsage,
  type ThreadContextUsageUpdate,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";

type TurnUsage = Pick<OrchestrationV2ProviderTurn, "providerThreadId" | "tokenUsage">;

const fromTurn = (
  threadId: ThreadId,
  usage: NonNullable<TurnUsage["tokenUsage"]>,
): ThreadContextUsage => ({
  threadId,
  usedTokens: usage.usedTokens,
  maxTokens: usage.maxTokens != null && usage.maxTokens > 0 ? usage.maxTokens : null,
  updatedAt: usage.updatedAt,
});

const isNewer = (candidate: string, than: string) => Date.parse(candidate) >= Date.parse(than);

/**
 * What the chat's context meter reads: the active conversation's newest turn report, else the
 * usage carried on the provider thread itself. A retired conversation's reports never count.
 */
export function latestContextUsage(input: {
  readonly threadId: ThreadId;
  readonly activeProviderThreadId: ProviderThreadId | null;
  readonly providerThreads: ReadonlyArray<
    Pick<OrchestrationV2ProviderThread, "id" | "contextUsage" | "updatedAt">
  >;
  readonly providerTurns: ReadonlyArray<TurnUsage>;
}): ThreadContextUsage | null {
  const active = input.activeProviderThreadId;
  if (active === null) return null;
  let latest: NonNullable<TurnUsage["tokenUsage"]> | null = null;
  for (const turn of input.providerTurns) {
    if (turn.providerThreadId !== active || turn.tokenUsage === undefined) continue;
    if (latest === null || isNewer(turn.tokenUsage.updatedAt, latest.updatedAt)) {
      latest = turn.tokenUsage;
    }
  }
  if (latest !== null) return fromTurn(input.threadId, latest);
  const providerThread = input.providerThreads.find((thread) => thread.id === active);
  const usage = providerThread?.contextUsage;
  if (providerThread === undefined || usage == null) return null;
  return {
    threadId: input.threadId,
    usedTokens: usage.usedTokens,
    maxTokens: usage.maxTokens ?? null,
    updatedAt: DateTime.formatIso(providerThread.updatedAt),
  };
}

const unavailable = () =>
  new ActivityLedgerError({ message: "Thread context usage could not be read." });

/** Each thread?s current usage, then every change, including a reset to unknown. */
export const stream = (threadIds: ReadonlyArray<ThreadId>) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const wanted = new Set(threadIds);
      const read = Effect.fn("ThreadContextUsage.read")(function* (threadId: ThreadId) {
        if ((yield* orchestrator.getThreadShell(threadId)) === null)
          return { threadId, usage: null };
        const records = yield* orchestrator.getThreadRecords(threadId, [
          "providerThreads",
          "providerTurns",
        ]);
        return {
          threadId,
          usage: latestContextUsage({
            threadId,
            activeProviderThreadId: records.thread.activeProviderThreadId,
            providerThreads: records.providerThreads,
            providerTurns: records.providerTurns,
          }),
        };
      });

      const changes = orchestrator.streamDomainEvents.pipe(
        Stream.filter(
          (event) =>
            wanted.has(event.threadId) &&
            (event.type === "provider-thread.updated" || event.type === "provider-turn.updated"),
        ),
        Stream.map((event) => event.threadId),
      );

      const sent = new Map<ThreadId, ThreadContextUsage | null>();
      return Stream.merge(Stream.fromIterable(wanted), changes).pipe(
        Stream.mapEffect(read),
        Stream.filter((update): update is ThreadContextUsageUpdate => {
          if (update === null) return false;
          const previous = sent.get(update.threadId);
          if (
            sent.has(update.threadId) &&
            previous?.usedTokens === update.usage?.usedTokens &&
            previous?.maxTokens === update.usage?.maxTokens
          )
            return false;
          sent.set(update.threadId, update.usage);
          return true;
        }),
        Stream.mapError(unavailable),
      );
    }),
  );
