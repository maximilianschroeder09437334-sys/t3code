import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

const layer = EventSink.layer.pipe(
  Layer.provideMerge(Layer.merge(EventStore.layer, ProjectionStore.layer)),
  Layer.provide(Sqlite.layerMemory),
);

it.effect("rejects a planned fork whose source was deleted before it committed", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const sourceId = ThreadId.make("fork-source");
    const targetId = ThreadId.make("fork-target");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const source: OrchestrationV2AppThread = {
      id: sourceId,
      projectId: ProjectId.make("project"),
      title: "Source",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { rootThreadId: sourceId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      lastVisitedAt: null,
    };
    yield* sink.write({
      events: [
        {
          id: EventId.make("source-created"),
          type: "thread.created",
          threadId: sourceId,
          occurredAt: now,
          payload: source,
        },
      ],
    });
    const plannedFork = {
      commandId: CommandId.make("fork"),
      commandType: "thread.fork",
      threadId: targetId,
      acceptedAt: now,
      effects: [],
      events: [
        {
          id: EventId.make("fork-created"),
          type: "thread.created" as const,
          threadId: targetId,
          occurredAt: now,
          payload: {
            ...source,
            id: targetId,
            forkedFrom: { type: "run" as const, threadId: sourceId, runId: RunId.make("run") },
          },
        },
      ],
    };
    yield* sink.write({
      events: [
        {
          id: EventId.make("source-deleted"),
          type: "thread.deleted",
          threadId: sourceId,
          occurredAt: now,
          payload: { ...source, deletedAt: now },
        },
      ],
    });
    const rejected = yield* sink.commitCommand(plannedFork);
    assert.equal(rejected.receipt.status, "rejected");
    assert.isFalse(rejected.committed);
    const replayed = yield* sink.commitCommand(plannedFork);
    assert.deepEqual(replayed.receipt, rejected.receipt);
    assert.isFalse(replayed.committed);
    const missing = yield* projections.getThread(targetId).pipe(Effect.flip);
    assert.instanceOf(missing, ProjectionStore.ProjectionStoreThreadNotFoundError);
  }).pipe(Effect.provide(layer)),
);

const failingReceiptCommandId = CommandId.make("cross-thread-rollback");
// The receipt is the last write of a command transaction, after its events, projections and outbox rows.
const receiptFailsLast = Layer.effect(
  CommandReceiptStore.CommandReceiptStoreV2,
  Effect.gen(function* () {
    const store = yield* CommandReceiptStore.CommandReceiptStoreV2;
    return {
      ...store,
      upsert: (receipt) =>
        receipt.commandId === failingReceiptCommandId
          ? Effect.fail(
              new CommandReceiptStore.CommandReceiptStoreWriteError({ commandId: receipt.commandId }),
            )
          : store.upsert(receipt),
    } satisfies CommandReceiptStore.CommandReceiptStoreV2Shape;
  }),
).pipe(Layer.provide(CommandReceiptStore.layer));
const crossThreadLayer = EventSink.layerFromStores.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      receiptFailsLast,
      EffectOutbox.layer,
      ProjectStore.layer,
      TurnItemPositionStore.layer,
      EventStore.layer,
      ProjectionStore.layer,
    ),
  ),
  Layer.provideMerge(Sqlite.layerMemory),
);

const crossThreadFixture = Effect.gen(function* () {
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const providerInstanceId = ProviderInstanceId.make("codex");
  const thread = (
    id: ThreadId,
    parentThreadId: ThreadId | null = null,
  ): OrchestrationV2AppThread => ({
    id,
    projectId: ProjectId.make("project"),
    title: id,
    createdBy: "user",
    creationSource: "web",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: parentThreadId ?? id,
      parentThreadId,
      relationshipToParent: parentThreadId === null ? null : "subagent",
    },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: null,
  });
  const predecessor = thread(ThreadId.make("predecessor"));
  const successor = thread(ThreadId.make("successor"));
  const child = thread(ThreadId.make("child"), predecessor.id);
  const threads = [predecessor, successor, child];
  // A child's creation reads its committed parent.
  for (const created of threads)
    yield* sink.write({
      events: [
        {
          id: EventId.make(`created:${created.id}`),
          type: "thread.created",
          threadId: created.id,
          occurredAt: now,
          payload: created,
        },
      ],
    });
  const command = (commandId: CommandId) => ({
    commandId,
    commandType: "test.cross-thread",
    threadId: predecessor.id,
    acceptedAt: now,
    events: threads.map((updated) => ({
      id: EventId.make(`${commandId}:${updated.id}`),
      type: "thread.metadata-updated" as const,
      threadId: updated.id,
      occurredAt: now,
      payload: { ...updated, title: `${updated.id} after ${commandId}` },
    })),
    effects: [
      {
        id: `effect:${commandId}`,
        commandId,
        threadId: child.id,
        request: { type: "provider-runtime.continue" as const, sourceRunId: RunId.make("run") },
      },
    ],
  });
  return { sink, threads, command };
});

it.effect("commits one command's events on three threads, its outbox row and receipt together", () =>
  Effect.gen(function* () {
    const { sink, threads, command } = yield* crossThreadFixture;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
    const commandId = CommandId.make("cross-thread-commit");
    const result = yield* sink.commitCommand(command(commandId));
    assert.isTrue(result.committed);
    assert.deepEqual(
      new Set(result.storedEvents.map((stored) => stored.event.threadId)),
      new Set(threads.map((thread) => thread.id)),
    );
    for (const thread of threads)
      assert.equal(
        (yield* projections.getThread(thread.id)).title,
        `${thread.id} after ${commandId}`,
      );
    assert.isTrue(Option.isSome(yield* outbox.get(`effect:${commandId}`)));
    assert.equal(Option.getOrThrow(yield* receipts.getByCommandId(commandId)).status, "accepted");
  }).pipe(Effect.provide(crossThreadLayer)),
);

it.effect("rolls back a failed three-thread command without events, projections, outbox or receipt", () =>
  Effect.gen(function* () {
    const { sink, threads, command } = yield* crossThreadFixture;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const events = yield* EventStore.EventStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
    const before = yield* Effect.forEach(threads, (thread) =>
      events.latestSequence({ threadId: thread.id }),
    );
    const failure = yield* sink.commitCommand(command(failingReceiptCommandId)).pipe(Effect.flip);
    assert.instanceOf(failure, EventSink.EventSinkWriteError);
    assert.deepEqual(
      yield* Effect.forEach(threads, (thread) => events.latestSequence({ threadId: thread.id })),
      before,
    );
    for (const thread of threads)
      assert.equal((yield* projections.getThread(thread.id)).title, thread.id);
    assert.isTrue(Option.isNone(yield* outbox.get(`effect:${failingReceiptCommandId}`)));
    assert.deepEqual(yield* outbox.listByCommandId(failingReceiptCommandId), []);
    assert.isTrue(Option.isNone(yield* receipts.getByCommandId(failingReceiptCommandId)));
  }).pipe(Effect.provide(crossThreadLayer)),
);
