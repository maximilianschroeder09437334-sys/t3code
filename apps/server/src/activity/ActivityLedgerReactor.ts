import type { OrchestrationV2DomainEvent, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import * as ActivityLedger from "./ActivityLedger.ts";

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

/** Ledger entries the server writes itself, keyed by the committed event so replays append once. */
export const reactToDomainEvent = Effect.fn("ActivityLedgerReactor.react")(function* (
  event: OrchestrationV2DomainEvent,
) {
  const handoff =
    event.type === "context-handoff.updated" && event.payload.status === "ready"
      ? event.payload
      : undefined;
  if (event.type !== "thread.settled" && handoff === undefined) return;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const ledger = yield* ActivityLedger.ActivityLedger;
  const threadId: ThreadId = event.threadId;
  const thread = yield* orchestrator.getThreadShell(threadId);
  if (thread === null) return;
  const entry =
    handoff === undefined
      ? {
          key: `settled:${event.id}`,
          kind: "settled" as const,
          summary: oneLine(`Settled: ${thread.title}`, 400),
        }
      : {
          key: `handoff:${handoff.id}`,
          kind: "handoff" as const,
          summary: oneLine(
            `Context handed off (${handoff.strategy.replaceAll("_", " ")}): ${thread.title}`,
            400,
          ),
        };
  yield* ledger.append({ ...entry, projectId: thread.projectId, threadId });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const ledger = yield* ActivityLedger.ActivityLedger;
    const react = (event: OrchestrationV2DomainEvent) =>
      reactToDomainEvent(event).pipe(
        Effect.provideService(Orchestrator.OrchestratorV2, orchestrator),
        Effect.provideService(ActivityLedger.ActivityLedger, ledger),
        // One failed entry must not stop the ledger from recording later events.
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("activity ledger reaction failed", {
                threadId: event.threadId,
                cause,
              }),
        ),
      );
    yield* forkParked(Stream.runForEach(orchestrator.streamDomainEvents, react));
  }),
);
