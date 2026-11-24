import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  type RunId,
  ThreadId,
  type TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import {
  CONTEXT_HANDOFF_NUDGE,
  CONTEXT_ROLLOVER_LIMIT,
  contextHandoffNudgeMessage,
  contextNoticeSteerCommandId,
  contextNoticeSteerMessageId,
  contextRolloverLimitMessage,
  contextRolloverNoticeId,
} from "./ContextRollover.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import {
  ProviderAdapterSteerDeclinedError,
  ProviderAdapterSteerRunError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2SteerInput,
  type ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

// ok: the provider takes it in (fake Claude reports it pending, then read). unsupported: no steering.
// declined/failed: the steer call fails. cancelled: Claude drops it unread at turn end. unacked:
// Claude's read never reaches the database. stale: the steer arrives after the next run started.
// stop: Stop reached the run first.
type SteerMode =
  | "ok"
  | "unacked"
  | "unsupported"
  | "declined"
  | "failed"
  | "cancelled"
  | "stale"
  | "stop";

type ScenarioInput = {
  readonly driverName: "codex" | "claudeAgent";
  readonly steer: SteerMode;
  readonly cap?: boolean;
  /** The first run's message; a goal command run is never steered into. */
  readonly firstMessage?: string;
};

/** A fake provider whose state outlives one server process, like the real native session. */
const fakeProvider = (input: ScenarioInput) =>
  Effect.gen(function* () {
    const driver = ProviderDriverKind.make(input.driverName);
    const instanceId = ProviderInstanceId.make(input.driverName);
    const modelSelection = { instanceId, model: "test-model" };
    const base =
      input.driverName === "codex" ? CodexProviderCapabilitiesV2 : ClaudeProviderCapabilitiesV2;
    const capabilities =
      input.steer === "unsupported" || input.steer === "stale"
        ? { ...base, turns: { ...base.turns, supportsActiveSteering: false } }
        : base;
    const cwd = yield* checkpointWorkspace(`context-notice-steer-${input.driverName}`);
    const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
    const started: ProviderAdapterV2TurnInput[] = [];
    const turns: OrchestrationV2ProviderTurn[] = [];
    const steers: ProviderAdapterV2SteerInput[] = [];
    const steerStatus = (
      steer: ProviderAdapterV2SteerInput,
      status: "pending" | "completed" | "cancelled",
    ): ProviderAdapterV2Event => ({
      type: "steer.updated",
      driver,
      threadId: steer.threadId,
      runId: steer.runId,
      messageId: steer.message.messageId,
      status,
    });
    const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
      instanceId,
      driver,
      getCapabilities: () => Effect.succeed(capabilities),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: (open) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          return {
            instanceId,
            driver,
            providerSessionId: open.providerSessionId,
            providerSession: {
              id: open.providerSessionId,
              driver,
              providerInstanceId: instanceId,
              status: "ready",
              cwd,
              model: modelSelection.model,
              capabilities,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            },
            events: Stream.fromQueue(events),
            ...(input.driverName === "claudeAgent"
              ? { steerAcknowledgedByEvent: true as const }
              : {}),
            ensureThread: ({ threadId }) =>
              Effect.succeed({
                id: ProviderThreadId.make(`provider-thread:${input.driverName}:${threadId}`),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: open.providerSessionId,
                appThreadId: threadId,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
              }),
            resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
            startTurn: (turn) =>
              Effect.gen(function* () {
                started.push(turn);
                const providerTurn: OrchestrationV2ProviderTurn = {
                  id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                  providerThreadId: turn.providerThread.id,
                  nodeId: turn.rootNodeId,
                  runAttemptId: turn.attemptId,
                  nativeTurnRef: {
                    driver,
                    nativeId: `native:${turn.attemptId}`,
                    strength: "strong",
                  },
                  ordinal: turn.providerTurnOrdinal,
                  status: "running",
                  startedAt: now,
                  completedAt: null,
                };
                turns.push(providerTurn);
                yield* Queue.offer(events, { type: "provider_turn.updated", driver, providerTurn });
              }),
            steerTurn: (steer) =>
              input.steer === "declined"
                ? Effect.fail(
                    new ProviderAdapterSteerDeclinedError({
                      driver,
                      providerThreadId: steer.providerThread.id,
                      providerTurnId: steer.providerTurnId,
                    }),
                  )
                : input.steer === "failed"
                  ? Effect.fail(
                      new ProviderAdapterSteerRunError({
                        driver,
                        providerThreadId: steer.providerThread.id,
                        providerTurnId: steer.providerTurnId,
                      }),
                    )
                  : Effect.gen(function* () {
                      steers.push(steer);
                      if (input.driverName !== "claudeAgent" || input.steer === "unacked") return;
                      yield* Queue.offer(events, steerStatus(steer, "pending"));
                      if (input.steer === "ok")
                        yield* Queue.offer(events, steerStatus(steer, "completed"));
                    }),
            interruptTurn: () => Effect.void,
            respondToRuntimeRequest: () => Effect.die("unused"),
            readThreadSnapshot: () => Effect.die("unused"),
            rollbackThread: () => Effect.die("unused"),
            forkThread: () => Effect.die("unused"),
          };
        }),
    };
    return { driver, modelSelection, cwd, events, started, turns, steers, steerStatus, adapter };
  });

type FakeProvider = Effect.Success<ReturnType<typeof fakeProvider>>;

/** Drives the thread through one server process's services. */
const threadDriver = (fake: FakeProvider, input: ScenarioInput) =>
  Effect.gen(function* () {
    const { driver, modelSelection, cwd, events, started, turns, steers, steerStatus } = fake;
    {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = ThreadId.make(`thread:context-notice-steer-${input.driverName}`);
      const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
        orchestrator.streamDomainEvents.pipe(
          Stream.filter(predicate),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
      // Stop's interrupt waits for a provider stop this fake never sends, so it is left queued.
      const drain = input.steer === "stop" ? Effect.void : worker.drain();
      const send = (id: string, text = id) =>
        Effect.gen(function* () {
          const known = new Set(turns.map((turn) => turn.id));
          const running = yield* watch(
            (event) =>
              event.type === "provider-turn.updated" &&
              event.payload.status === "running" &&
              !known.has(event.payload.id),
          );
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(id),
            threadId,
            messageId: MessageId.make(`message:${id}`),
            text,
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain();
          yield* Fiber.join(running);
        });
      // A new notice that can steer is awaited through its steer message.
      const usage = (usedTokens: number, notice?: TurnItemId) =>
        Effect.gen(function* () {
          const turn = turns.at(-1)!;
          const now = yield* DateTime.now;
          const seen = yield* watch(
            (event) =>
              event.type === "provider-turn.updated" &&
              event.payload.id === turn.id &&
              event.payload.tokenUsage?.usedTokens === usedTokens,
          );
          const steerId =
            notice === undefined ||
            input.steer === "unsupported" ||
            input.steer === "stale" ||
            input.steer === "stop" ||
            input.firstMessage !== undefined
              ? undefined
              : contextNoticeSteerMessageId(notice);
          const steered =
            steerId === undefined
              ? undefined
              : yield* watch(
                  (event) => event.type === "message.updated" && event.payload.id === steerId,
                );
          yield* Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: {
              ...turn,
              tokenUsage: { usedTokens, updatedAt: DateTime.formatIso(now) },
            },
          });
          yield* Fiber.join(seen);
          if (steered !== undefined) yield* Fiber.join(steered);
          yield* drain;
        });
      const complete = Effect.gen(function* () {
        const turn = turns.at(-1)!;
        const now = yield* DateTime.now;
        const done = yield* watch(
          (event) => event.type === "run.updated" && event.payload.status === "completed",
        );
        // Claude drops a steer it never read when the turn ends.
        if (input.steer === "cancelled")
          for (const steer of steers) yield* Queue.offer(events, steerStatus(steer, "cancelled"));
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...turn, status: "completed", completedAt: now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.id,
          runOrdinal: started.at(-1)!.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(done);
      });
      const create = orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId,
        projectId: ProjectId.make("project:context-notice-steer"),
        title: "Context notice steer",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "feature/x",
        worktreePath: cwd,
        createdBy: "user",
        creationSource: "web",
      });
      // The steer a reaction would send for a notice, here sent late or to another run.
      const lateSteer = (notice: TurnItemId, targetRunId: RunId, attempt: string) =>
        Effect.gen(function* () {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`${contextNoticeSteerCommandId(notice)}:${attempt}`),
            threadId,
            messageId: contextNoticeSteerMessageId(notice),
            createdBy: "agent",
            creationSource: "server",
            text: contextHandoffNudgeMessage,
            attachments: [],
            dispatchMode: { type: "steer_active", targetRunId },
          });
          yield* drain;
        });
      // Every status the notice's steer item is persisted with, in order.
      const steerStatuses = (messageId: MessageId) =>
        Effect.gen(function* () {
          const statuses: string[] = [];
          yield* orchestrator.streamDomainEvents.pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                if (
                  event.type === "turn-item.updated" &&
                  event.payload.type === "user_message" &&
                  event.payload.messageId === messageId
                )
                  statuses.push(event.payload.status);
              }),
            ),
            Effect.forkScoped,
          );
          return statuses;
        });
      return {
        orchestrator,
        threadId,
        watch,
        drain,
        send,
        usage,
        complete,
        create,
        lateSteer,
        steerStatuses,
      };
    }
  });

const occurrences = (text: string, part: string) => text.split(part).length - 1;

const contextNoticeScenario = (input: ScenarioInput) =>
  Effect.gen(function* () {
    const fake = yield* fakeProvider(input);
    const { started, steers, adapter } = fake;
    yield* Effect.gen(function* () {
      const { orchestrator, threadId, send, usage, complete, create, lateSteer, steerStatuses } =
        yield* threadDriver(fake, input);
      yield* create;
      yield* send("Build it", input.firstMessage);
      const provider = (yield* orchestrator.getThreadProjection(threadId)).providerThreads[0]!;
      const nudgeId = contextRolloverNoticeId(provider, CONTEXT_HANDOFF_NUDGE)!;
      const firstRunId = started[0]!.runId;
      const statuses = yield* steerStatuses(contextNoticeSteerMessageId(nudgeId));
      if (input.steer === "stop") {
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("stop"),
          threadId,
          runId: firstRunId,
        });
      }
      yield* usage(160_000, nudgeId);
      // Repeated usage above the threshold does not steer again.
      yield* usage(170_000);
      if (input.cap) {
        yield* usage(260_000, contextRolloverNoticeId(provider, CONTEXT_ROLLOVER_LIMIT)!);
        yield* usage(270_000);
      }
      const offered = input.steer === "ok" || input.steer === "cancelled";
      const reachedDispatch = offered || input.steer === "declined" || input.steer === "failed";
      if (input.firstMessage !== undefined) {
        // The notice is recorded, but the reaction leaves a goal command or compaction run alone.
        const excluded = yield* orchestrator.getThreadProjection(threadId);
        assert.isTrue(excluded.turnItems.some((item) => item.id === nudgeId));
        assert.lengthOf(steers, 0);
        assert.isFalse(
          excluded.messages.some((message) => message.id === contextNoticeSteerMessageId(nudgeId)),
        );
        assert.deepEqual(statuses, []);
        return;
      }
      if (input.steer === "stop") {
        // Neither the reaction nor a late steer joins a run that Stop reached.
        yield* lateSteer(nudgeId, firstRunId, "after-stop");
        assert.lengthOf(steers, 0);
        const stopped = yield* orchestrator.getThreadProjection(threadId);
        assert.isFalse(
          stopped.messages.some((message) => message.id === contextNoticeSteerMessageId(nudgeId)),
        );
        return;
      }
      // A reaction replayed after a restart finds the notice already sent and does nothing.
      if (input.steer === "ok") yield* lateSteer(nudgeId, firstRunId, "replayed");
      const steered = steers.map((steer) => steer.message.text);
      assert.lengthOf(steered, offered ? (input.cap ? 2 : 1) : 0);
      if (offered) assert.equal(steered[0], contextHandoffNudgeMessage);
      if (input.cap && offered) assert.include(steered[1], contextRolloverLimitMessage);
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const steerMessage = projection.messages.find(
        (message) => message.id === contextNoticeSteerMessageId(nudgeId),
      );
      assert.equal(steerMessage !== undefined, reachedDispatch);
      yield* complete;
      yield* send("Next step");
      if (input.steer === "stale") {
        // The reaction read turn A as running, then A completed and run B inlined the notice.
        // Its delayed steer, to A or to B, is dropped instead of becoming another run.
        yield* lateSteer(nudgeId, firstRunId, "stale");
        yield* lateSteer(nudgeId, started.at(-1)!.runId, "wrong-run");
        assert.lengthOf(steers, 0);
      }
      // No notice ever becomes a run of its own, started or queued, and a steer that missed its
      // turn stays in that turn instead of moving to a later run.
      assert.lengthOf(started, 2);
      const settled = yield* orchestrator.getThreadProjection(threadId);
      assert.lengthOf(settled.runs, 2);
      assert.deepEqual(
        settled.messages
          .filter((message) => message.id === contextNoticeSteerMessageId(nudgeId))
          .map((message) => message.runId),
        reachedDispatch ? [firstRunId] : [],
      );
      const next = started.at(-1)!;
      assert.notEqual(next.runId, firstRunId);
      const text = next.message.text;
      // Only a steer the provider took in replaces the inline; otherwise it is inlined once.
      const accepted = input.steer === "ok";
      if (input.cap) {
        assert.equal(occurrences(text, contextRolloverLimitMessage), accepted ? 0 : 1);
        assert.isFalse(text.includes(contextHandoffNudgeMessage));
      } else {
        assert.equal(occurrences(text, contextHandoffNudgeMessage), accepted ? 0 : 1);
      }
      // The steer item is persisted unaccepted before the provider sees it; only the provider's
      // acknowledgement (Claude's read event, or a synchronous steer that returned) completes it.
      if (reachedDispatch)
        assert.deepEqual(statuses, ["pending", accepted ? "completed" : "cancelled"]);
    }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerWithRegistry(
          { name: `context-notice-steer-${input.driverName}` },
          ProviderAdapterRegistry.layerSingle(adapter),
          { runEffectWorker: false },
        ),
      ),
    );
  });

it.effect.each(["codex", "claudeAgent"] as const)(
  "%s steers the 150k notice into the running turn once and does not inline it next run",
  (driverName) => contextNoticeScenario({ driverName, steer: "ok" }),
);

it.effect.each(["codex", "claudeAgent"] as const)(
  "%s steers the 250k cap once and does not inline it into the follow-up run",
  (driverName) => contextNoticeScenario({ driverName, steer: "ok", cap: true }),
);

it.effect("inlines the 150k notice at the next run when the provider cannot steer", () =>
  contextNoticeScenario({ driverName: "codex", steer: "unsupported" }),
);

it.effect("inlines the 250k cap as before when the provider cannot steer", () =>
  contextNoticeScenario({ driverName: "claudeAgent", steer: "unsupported", cap: true }),
);

it.effect("inlines a declined 150k steer once at the next run without a follow-up run", () =>
  contextNoticeScenario({ driverName: "codex", steer: "declined" }),
);

it.effect("inlines the 150k notice once at the next run after a generic steer failure", () =>
  contextNoticeScenario({ driverName: "codex", steer: "failed" }),
);

it.effect("inlines the 250k cap once at the next run after a generic steer failure", () =>
  contextNoticeScenario({ driverName: "codex", steer: "failed", cap: true }),
);

it.effect("inlines a Claude steer that stayed pending and was cancelled when its turn ended", () =>
  contextNoticeScenario({ driverName: "claudeAgent", steer: "cancelled" }),
);

it.effect("inlines a cancelled Claude 250k steer once at the next run", () =>
  contextNoticeScenario({ driverName: "claudeAgent", steer: "cancelled", cap: true }),
);

it.effect("drops a stale or wrong-run notice steer after the next run inlined it", () =>
  contextNoticeScenario({ driverName: "codex", steer: "stale" }),
);

it.effect("never steers a notice into a goal command run", () =>
  contextNoticeScenario({ driverName: "codex", steer: "ok", firstMessage: "/goal Build it" }),
);

it.effect("never steers a notice into a run that Stop reached", () =>
  contextNoticeScenario({ driverName: "codex", steer: "stop" }),
);

/** A temporary database file, removed with the test's scope. */
const databaseFile = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-notice-restart-" });
  return path.join(directory, "state.sqlite");
}).pipe(Effect.provide(NodeServices.layer));

// Process 1 steers the 150k notice into Claude's running turn and dies with the turn still running.
// Process 2 is a fresh build over the same file: startup recovery, then the next user message.
const restartScenario = (acknowledged: boolean) =>
  Effect.gen(function* () {
    const input: ScenarioInput = {
      driverName: "claudeAgent",
      steer: acknowledged ? "ok" : "unacked",
    };
    const fake = yield* fakeProvider(input);
    const database = SqlitePersistence.layerFromPath(yield* databaseFile).pipe(
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    );
    const inProcess =
      (restarted: boolean) =>
      <A, E, R>(body: Effect.Effect<A, E, R>) =>
        Effect.scoped(body).pipe(
          Effect.provide(
            Layer.fresh(
              ProviderReplayHarness.layerWithRegistry(
                { name: "context-notice-steer-restart" },
                ProviderAdapterRegistry.layerSingle(fake.adapter),
                restarted
                  ? { databaseLayer: database, recoverOnStartup: true }
                  : { databaseLayer: database, runEffectWorker: false },
              ),
            ),
          ),
        );
    const steerItem = (
      projection: { readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem> },
      id: MessageId,
    ) => projection.turnItems.find((item) => item.type === "user_message" && item.messageId === id);
    const first = yield* inProcess(false)(
      Effect.gen(function* () {
        const t = yield* threadDriver(fake, input);
        yield* t.create;
        yield* t.send("Build it");
        const provider = (yield* t.orchestrator.getThreadProjection(t.threadId))
          .providerThreads[0]!;
        const nudgeId = contextRolloverNoticeId(provider, CONTEXT_HANDOFF_NUDGE)!;
        const steerId = contextNoticeSteerMessageId(nudgeId);
        const statuses = yield* t.steerStatuses(steerId);
        const read = yield* t.watch(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.type === "user_message" &&
            event.payload.messageId === steerId &&
            event.payload.status === "completed",
        );
        yield* t.usage(160_000, nudgeId);
        if (acknowledged) yield* Fiber.join(read);
        assert.lengthOf(fake.steers, 1, "the notice was offered to the running turn");
        return {
          threadId: t.threadId,
          steerId,
          firstRunId: fake.started[0]!.runId,
          // The steer effect is recorded as done either way; only Claude's read event accepts it.
          beforeDeath: [...statuses],
        };
      }),
    );
    yield* inProcess(true)(
      Effect.gen(function* () {
        const t = yield* threadDriver(fake, input);
        const recovered = yield* t.orchestrator.getThreadProjection(first.threadId);
        yield* t.send("Next step");
        const next = fake.started.at(-1)!;
        assert.notEqual(next.runId, first.firstRunId);
        assert.equal(
          occurrences(next.message.text, contextHandoffNudgeMessage),
          acknowledged ? 0 : 1,
          acknowledged ? "a read steer is not inlined again" : "an unread steer is inlined once",
        );
        assert.lengthOf(fake.steers, 1, "a restart never steers the notice again");
        // Recovery cancels an unread steer of the lost turn.
        assert.equal(
          steerItem(recovered, first.steerId)?.status,
          acknowledged ? "completed" : "cancelled",
        );
        yield* t.complete;
        yield* t.send("Then this");
        assert.equal(occurrences(fake.started.at(-1)!.message.text, contextHandoffNudgeMessage), 0);
        assert.lengthOf(fake.steers, 1);
      }),
    );
    assert.deepEqual(first.beforeDeath, acknowledged ? ["pending", "completed"] : ["pending"]);
  });

it.effect("inlines once after a restart lost Claude's read of an offered notice steer", () =>
  restartScenario(false),
);

it.effect("neither inlines nor re-steers after a restart once Claude read the notice steer", () =>
  restartScenario(true),
);
