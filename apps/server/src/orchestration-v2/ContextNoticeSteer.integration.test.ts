import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
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
  type ProviderAdapterV2Event,
  type ProviderAdapterV2SteerInput,
  type ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

type SteerMode = "ok" | "unsupported" | "declined";

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
      input.steer === "unsupported"
        ? { ...base, turns: { ...base.turns, supportsActiveSteering: false } }
        : base;
    const cwd = yield* checkpointWorkspace(`context-notice-steer-${input.driverName}`);
    const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
    const started: ProviderAdapterV2TurnInput[] = [];
    const turns: OrchestrationV2ProviderTurn[] = [];
    const steers: ProviderAdapterV2SteerInput[] = [];
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
                : Effect.sync(() => {
                    steers.push(steer);
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
            notice === undefined || input.steer === "unsupported"
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
          yield* worker.drain();
        });
      const complete = Effect.gen(function* () {
        const turn = turns.at(-1)!;
        const now = yield* DateTime.now;
        const done = yield* watch(
          (event) => event.type === "run.updated" && event.payload.status === "completed",
        );
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
      yield* send("Build it");
      const provider = (yield* orchestrator.getThreadProjection(threadId)).providerThreads[0]!;
      const nudgeId = contextRolloverNoticeId(provider, CONTEXT_HANDOFF_NUDGE)!;
      yield* usage(160_000, nudgeId);
      // Repeated usage above the threshold does not steer again.
      yield* usage(170_000);
      if (input.cap) {
        yield* usage(260_000, contextRolloverNoticeId(provider, CONTEXT_ROLLOVER_LIMIT)!);
        yield* usage(270_000);
      }
      const steered = steers.map((steer) => steer.message.text);
      assert.lengthOf(steered, input.steer === "ok" ? (input.cap ? 2 : 1) : 0);
      if (input.steer === "ok") assert.equal(steered[0], contextHandoffNudgeMessage);
      if (input.cap && input.steer === "ok")
        assert.include(steered[1], contextRolloverLimitMessage);
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const steerMessage = projection.messages.find(
        (message) => message.id === contextNoticeSteerMessageId(nudgeId),
      );
      assert.equal(steerMessage !== undefined, input.steer !== "unsupported");
      yield* complete;
      yield* send("Next step");
      const next = started.at(-1)!;
      assert.notEqual(next.runId, started[0]!.runId);
      const text = next.message.text;
      if (input.cap) {
        // The cap is inlined into the next run only when it was not steered into this one.
        assert.equal(text.includes(contextRolloverLimitMessage), input.steer !== "ok");
        assert.isFalse(text.includes(contextHandoffNudgeMessage));
      } else if (input.steer === "declined") {
        // A declined steer runs as its own message after the turn; it is not inlined again.
        const messages = started.slice(1).map((turn) => turn.message.text);
        assert.equal(
          messages.filter((message) => message.includes(contextHandoffNudgeMessage)).length,
          1,
        );
      } else {
        assert.equal(text.includes(contextHandoffNudgeMessage), input.steer === "unsupported");
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

it.effect("delivers a declined 150k steer exactly once as its own follow-up", () =>
  contextNoticeScenario({ driverName: "codex", steer: "declined" }),
);
