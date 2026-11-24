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
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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

// ok: the provider takes the steer in. unsupported: no active steering, so the next run inlines.
// declined/failed: the steer call fails. cancelled: Claude offers it, reports it pending, then drops
// it unread when the turn ends. stale: the reaction's steer arrives after its turn completed and
// the next run started. stop: Stop reached the run before the notice.
type SteerMode = "ok" | "unsupported" | "declined" | "failed" | "cancelled" | "stale" | "stop";

const contextNoticeScenario = (input: {
  readonly driverName: "codex" | "claudeAgent";
  readonly steer: SteerMode;
  readonly cap?: boolean;
}) =>
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
      status: "pending" | "cancelled",
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
                      if (input.steer === "cancelled")
                        yield* Queue.offer(events, steerStatus(steer, "pending"));
                    }),
            interruptTurn: () => Effect.void,
            respondToRuntimeRequest: () => Effect.die("unused"),
            readThreadSnapshot: () => Effect.die("unused"),
            rollbackThread: () => Effect.die("unused"),
            forkThread: () => Effect.die("unused"),
          };
        }),
    };
    yield* Effect.gen(function* () {
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
      const send = (id: string) =>
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
            text: id,
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
            input.steer === "stop"
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
      yield* orchestrator.dispatch({
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
      const occurrences = (text: string, part: string) => text.split(part).length - 1;
      yield* send("Build it");
      const provider = (yield* orchestrator.getThreadProjection(threadId)).providerThreads[0]!;
      const nudgeId = contextRolloverNoticeId(provider, CONTEXT_HANDOFF_NUDGE)!;
      const firstRunId = started[0]!.runId;
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

it.effect("never steers a notice into a run that Stop reached", () =>
  contextNoticeScenario({ driverName: "codex", steer: "stop" }),
);
