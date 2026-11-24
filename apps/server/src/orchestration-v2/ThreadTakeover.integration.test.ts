// Slice B WP2 + WP3 (plan-b-r6 §3-§6, §9): the bounded synchronous takeover, its one-transaction
// commit, guard G, the forward effect, durable obligations and the live reconciler, against the
// real EventSink, projections, outbox and effect worker. `[F]` assertions are red on cc15112571
// through the baseline adapter below; `[G]` pass on both; `[N]` run on the branch.
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { classifyHomeNotification } from "@t3tools/shared/homeNotificationRules";
import { pullRequestWatchTaskId } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as References from "effect/References";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as DelegatedTaskQuestionReactor from "./DelegatedTaskQuestionReactor.ts";
import * as ServerConfig from "../config.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as ProviderTurnStartServiceTestkit from "./ProviderTurnStartService.testkit.ts";
import { activeShellRowsForSubscriber } from "./ShellStream.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const layerPlatformTest = Layer.merge(
  Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);
const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-thread-takeover-",
});
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("codex");
/** A test that starts a real provider turn sets `open`; any other session open dies. */
const TestSession = Context.Reference<
  ProviderAdapter.ProviderAdapterV2["Service"]["openSession"] | undefined
>("test/TakeoverSession", { defaultValue: () => undefined });
const FixtureThreads = Context.Reference<ReadonlyArray<ThreadId> | undefined>(
  "test/TakeoverFixture",
  { defaultValue: () => undefined },
);

const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:test" },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter: {
    instanceId: modelSelection.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.flatMap(
        TestSession,
        (open) => open?.(input) ?? Effect.die("sessions are not used by takeover tests"),
      ),
  } as ProviderAdapter.ProviderAdapterV2["Service"],
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

/** Declared by its key, as the probe below is; off unless a test asks, so takeovers stay explicit. */
type AutoTakeover = {
  readonly enabled: boolean;
  readonly attempts: number;
  readonly retrySpacingMs: number;
  readonly seedBatchSize?: number;
};
const autoTakeoverOff: AutoTakeover = { enabled: false, attempts: 1, retrySpacingMs: 0 };
const AutoTakeoverSettings = Context.Reference<AutoTakeover>(
  "t3/orchestration-v2/AutoTakeoverSettings",
  { defaultValue: () => autoTakeoverOff },
);

/** The server's layers over `persistence`: one in-memory database per test file, or a file. */
const makeLayerTest = <ROut, E, R>(
  persistence: Layer.Layer<ROut, E, R>,
  autoTakeover: AutoTakeover = autoTakeoverOff,
) =>
  Layer.mergeAll(
    RuntimeLayer.layer,
    RuntimeLayer.layerEventSink,
    // The orchestrator's own executor (layers are shared by reference), so held locks are real.
    ThreadCommandExecutor.layer,
    EffectOutbox.layer,
    ProjectionStore.layer,
  ).pipe(
    Layer.provideMerge(RuntimeLayer.layerProjectService),
    Layer.provide(
      Layer.mock(WorkspacePaths.WorkspacePaths)({
        normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
      }),
    ),
    Layer.provide(ProviderTurnStartServiceTestkit.layer),
    Layer.provide(
      Layer.succeed(ProjectEnrichmentService.ProjectEnrichmentService, {
        peek: () =>
          Effect.succeed({
            repositoryIdentity: null,
            faviconPath: null,
            repositoryIdentityResolved: false,
          }),
        request: () => Effect.void,
        readRepositoryIdentity: () => Effect.succeed(null),
        getAvailable: () =>
          Effect.succeed({
            repositoryIdentity: null,
            faviconPath: null,
            repositoryIdentityResolved: false,
          }),
        invalidate: () => Effect.void,
        refreshRepositoryIdentity: () => Effect.void,
        subscribeChanges: Effect.never,
      }),
    ),
    Layer.provide(McpSessionRegistryTestkit.layer),
    Layer.provide(McpProviderSessions.layer),
    Layer.provideMerge(persistence),
    Layer.provide(
      CheckpointStore.layer.pipe(
        Layer.provide(VcsDriverRegistry.layer),
        Layer.provide(VcsProcess.layer),
        Layer.provide(layerServerConfig),
        Layer.provide(layerPlatformTest),
      ),
    ),
    Layer.provide(layerServerConfig),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: (instanceId) =>
          Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
        listInstances: Effect.succeed([providerInstance]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      }),
    ),
    Layer.provide(layerPlatformTest),
    Layer.provideMerge(Layer.succeed(AutoTakeoverSettings, autoTakeover)),
  );
const layerTest = makeLayerTest(SqlitePersistence.layerMemory);

type Thread = OrchestrationV2AppThread & {
  readonly ownership?: { readonly ownerThreadId: ThreadId; readonly anchorTaskId: NodeId };
  readonly continuedBy?: {
    readonly threadId: ThreadId;
    readonly transferId: string;
    readonly attempt: number;
    readonly state: string;
    readonly deadlineAt: DateTime.Utc;
  };
};
type Task = OrchestrationV2Subagent;
type TakeoverOutcome =
  | {
      readonly ok: true;
      readonly result: {
        readonly transferId: string;
        readonly alreadyDeliveredToPredecessor: ReadonlyArray<ThreadId>;
        readonly migrated: ReadonlyArray<{ readonly childThreadId: ThreadId }>;
      };
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** A sidebar thread with a running provider turn, as a working agent's thread is. */
const seedThread = (input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly launchedBy?: ThreadId;
  readonly createProject?: boolean;
}) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    if (input.createProject === true) {
      const projects = yield* ProjectService.ProjectService;
      yield* projects.create({
        commandId: CommandId.make(`seed-project:${input.projectId}`),
        projectId: input.projectId,
        title: "Takeover",
        workspaceRoot: `/workspace/${input.projectId}`,
      });
    }
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: input.launchedBy === undefined ? "user" : "agent",
      creationSource: input.launchedBy === undefined ? "web" : "mcp",
      commandId: CommandId.make(`seed-create:${input.threadId}`),
      threadId: input.threadId,
      projectId: input.projectId,
      title: `Thread ${input.threadId}`,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      ...(input.launchedBy === undefined
        ? {}
        : {
            launchedBy: {
              threadId: input.launchedBy,
              commandId: CommandId.make(`launch:${input.threadId}`),
              at: now,
            },
          }),
    } as never);
    const providerThreadId = ProviderThreadId.make(`provider:${input.threadId}`);
    const runId = RunId.make(`run:${input.threadId}`);
    const rootNodeId = NodeId.make(`root:${input.threadId}`);
    yield* sink.write({
      events: [
        {
          id: EventId.make(`seed-provider-thread:${input.threadId}`),
          type: "provider-thread.updated",
          threadId: input.threadId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerSessionId: null,
            appThreadId: input.threadId,
            ownerNodeId: rootNodeId,
            nativeThreadRef: { driver, nativeId: `native:${input.threadId}`, strength: "strong" },
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make(`seed-run:${input.threadId}`),
          type: "run.updated",
          threadId: input.threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId: input.threadId,
            ordinal: 1,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: MessageId.make(`seed-message:${input.threadId}`),
            rootNodeId,
            activeAttemptId: null,
            status: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
            delegatedCompletion: { disposition: "open", nextGeneration: 1, delivery: null },
          },
        },
        {
          id: EventId.make(`seed-root:${input.threadId}`),
          type: "node.updated",
          threadId: input.threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: {
            id: rootNodeId,
            threadId: input.threadId,
            runId,
            parentNodeId: null,
            rootNodeId,
            kind: "root_turn",
            status: "running",
            countsForRun: true,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        },
      ],
    });
    return { runId, rootNodeId };
  });

/** P with a running turn, its app-owned child C, and S launched by P with its own running turn. */
const setup = (
  name: string,
  options: {
    readonly completionWake?: "always" | "settled_only";
    readonly successors?: number;
  } = {},
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projectId = ProjectId.make(`${name}-project`);
    const predecessor = ThreadId.make(`${name}-p`);
    const parent = yield* seedThread({ threadId: predecessor, projectId, createProject: true });
    const successors: Array<ThreadId> = [];
    for (let index = 0; index < (options.successors ?? 1); index++) {
      const id = ThreadId.make(`${name}-s${index === 0 ? "" : index + 1}`);
      yield* seedThread({ threadId: id, projectId, launchedBy: predecessor });
      successors.push(id);
    }
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      createdBy: "agent",
      creationSource: "mcp",
      commandId: CommandId.make(`${name}-delegate`),
      parentThreadId: predecessor,
      parentRunId: parent.runId,
      parentNodeId: parent.rootNodeId,
      task: "Investigate the migration.",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: options.completionWake ?? "always",
    });
    const task = (yield* orchestrator.getThreadProjection(predecessor)).subagents.find(
      (candidate) => candidate.runId === parent.runId && candidate.childThreadId !== null,
    )!;
    return {
      predecessor,
      successor: successors[0]!,
      successors,
      child: task.childThreadId!,
      taskId: task.id,
      predecessorRunId: parent.runId,
    };
  });

/** False on cc15112571, which has no takeover: `[N]` tests stop there instead of waiting. */
const hasTakeover = Effect.map(
  Orchestrator.OrchestratorV2,
  (orchestrator) =>
    (orchestrator as { readonly takeoverThread?: unknown }).takeoverThread !== undefined,
);
const requireTakeover = Effect.flatMap(hasTakeover, (available) =>
  available ? Effect.void : Effect.sync(() => assert.fail("[N]: this build has no takeover")),
);

/** The baseline adapter (plan §9): .23 has no takeover, so S settles P as t3_thread_organize does. */
const takeover = (predecessorThreadId: ThreadId, successorThreadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const takeoverThread = (orchestrator as { readonly takeoverThread?: unknown })
      .takeoverThread as
      | ((input: {
          readonly predecessorThreadId: ThreadId;
          readonly successorThreadId: ThreadId;
        }) => Effect.Effect<TakeoverOutcome, Orchestrator.OrchestratorV2Error>)
      | undefined;
    if (takeoverThread === undefined) {
      yield* orchestrator
        .dispatch({
          type: "thread.settle",
          commandId: CommandId.make(`baseline-settle:${predecessorThreadId}:${successorThreadId}`),
          threadId: predecessorThreadId,
        })
        .pipe(Effect.ignore);
      return { ok: false, code: "baseline", message: "no takeover on .23" } as TakeoverOutcome;
    }
    return yield* takeoverThread({ predecessorThreadId, successorThreadId });
  });

const thread = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.getThreadProjection(threadId),
  ).pipe(Effect.map((projection) => projection.thread as Thread));
const ownerOf = (child: Thread) => child.ownership?.ownerThreadId ?? child.lineage.parentThreadId;

/**
 * `recorded(X, a)` (§9): X has a task for C whose result is attempt a or a later run of C. A task
 * without `resultRunId` (.23) is the one run a's `delegatedTaskId` (or C's origin task) names.
 */
const recordedTask = (holder: ThreadId, child: ThreadId, runId: RunId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const childProjection = yield* orchestrator.getThreadProjection(child);
    const run = childProjection.runs.find((candidate) => candidate.id === runId)!;
    const ordinal = (id: RunId) =>
      childProjection.runs.find((candidate) => candidate.id === id)?.ordinal ?? -1;
    const forkedFrom = childProjection.thread.forkedFrom;
    const boundTaskId =
      run.delegatedTaskId ?? (forkedFrom?.type === "node" ? forkedFrom.nodeId : undefined);
    return (yield* orchestrator.getThreadProjection(holder)).subagents.find((task: Task) => {
      if (task.childThreadId !== child || task.result === null) return false;
      return task.resultRunId !== undefined
        ? ordinal(task.resultRunId) >= run.ordinal
        : task.id === boundTaskId && task.transferredTo === undefined;
    }) as Task | undefined;
  });
const notifiable = (task: Task | undefined) =>
  task !== undefined &&
  ["pending", "claimed", "delivered", "acknowledged"].includes(
    task.completionDelivery?.state ?? "",
  );

/**
 * Ends C's current run as the provider would and waits until some thread records its result, so
 * a build that records it on the predecessor fails on the caller's assertion rather than here.
 * With `snapshot`, the terminal write is built from that earlier copy of the run, as the run
 * executor builds it from its turn-start snapshot (without `delegatedCompletion`).
 */
const finishChild = (
  child: ThreadId,
  status: "completed" | "failed" = "completed",
  snapshot?: OrchestrationV2Run,
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const latest = (yield* orchestrator.getThreadProjection(child)).runs.toSorted(
      (a, b) => b.ordinal - a.ordinal,
    )[0]!;
    const { delegatedCompletion: _delegatedCompletion, ...stale } = snapshot ?? latest;
    const run = snapshot === undefined ? latest : stale;
    const afterSequence = yield* sink.latestSequence();
    const settled = yield* sink.stream({ afterSequence, eventType: "subagent.updated" }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "subagent.updated" &&
          stored.event.payload.childThreadId === child &&
          stored.event.payload.result !== null &&
          stored.event.payload.transferredTo === undefined,
      ),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkChild,
    );
    yield* sink.write({
      events: [
        {
          id: EventId.make(`finish:${run.id}:${status}`),
          type: "run.updated",
          threadId: child,
          runId: run.id,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: { ...run, status, completedAt: now },
        },
      ],
    });
    // Bounded in real time: a build that records the result nowhere fails on the caller's assertion.
    yield* TestClock.withLive(Fiber.join(settled).pipe(Effect.timeoutOption("5 seconds")));
    return run.id;
  });

/** Holds thread locks in `order` until released, as a competing command would. */
const holdLocks = (order: ReadonlyArray<ThreadId>, options: { readonly deletion?: boolean } = {}) =>
  Effect.gen(function* () {
    const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const acquired = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const body = order.reduceRight<Effect.Effect<void>>(
      (inner, id) => executor.withLock(id, inner),
      Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Deferred.await(release))),
    );
    const fiber = yield* Effect.forkChild(
      options.deletion === true ? executor.withDeletionLock(body) : body,
    );
    yield* Deferred.await(acquired);
    return Deferred.succeed(release, undefined).pipe(Effect.andThen(Fiber.join(fiber)));
  });

/** The takeover's debug milestones: each try-lock miss (by thread) and each joining call. */
const takeoverProbe = Effect.gen(function* () {
  const misses: Array<string> = [];
  const missed = yield* Deferred.make<void>();
  const joined = yield* Deferred.make<void>();
  const logger = Logger.make(({ message }) => {
    const parts = Array.isArray(message) ? message : [message];
    if (parts[0] === "Takeover try-lock missed") {
      misses.push(String(parts[1]));
      Deferred.doneUnsafe(missed, Effect.void);
    }
    if (parts[0] === "Takeover joined a running attempt") Deferred.doneUnsafe(joined, Effect.void);
  });
  const observe = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      Effect.provideService(References.MinimumLogLevel, "Debug"),
    );
  return { misses, missed, joined, observe };
});

/** Started before the call: completes once the predecessor records an `attempting` takeover. */
const attemptBegun = (predecessor: ThreadId) =>
  Effect.gen(function* () {
    // The baseline settles synchronously and records no attempt.
    if (!(yield* hasTakeover)) return yield* Effect.forkChild(Effect.void);
    const sink = yield* EventSink.EventSinkV2;
    const afterSequence = yield* sink.latestSequence();
    return yield* sink.stream({ afterSequence, eventType: "thread.metadata-updated" }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "thread.metadata-updated" &&
          stored.event.threadId === predecessor &&
          (stored.event.payload as Thread).continuedBy?.state === "attempting",
      ),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkChild,
    );
  });

it.layer(layerTest)("thread takeover attempt and commit", (it) => {
  it.effect("1: a child running at takeover reports its later result to the successor", () =>
    Effect.gen(function* () {
      const { predecessor, successor, child } = yield* setup("t1");
      const outcome = yield* takeover(predecessor, successor);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      // S's turn ends after the call; it then waits on the moved child.
      const sink = yield* EventSink.EventSinkV2;
      const successorRun = (yield* orchestrator.getThreadProjection(successor)).runs[0]!;
      const ended = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make(`t1-successor-turn-ended`),
            type: "run.updated",
            threadId: successor,
            runId: successorRun.id,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: ended,
            payload: { ...successorRun, status: "completed", completedAt: ended },
          },
        ],
      });
      // [F] S waits on C while it runs.
      const waitingOn = (yield* orchestrator.getThreadShell(successor))?.waitingOn ?? [];
      assert.isTrue(
        waitingOn.some((target) => target.threadId === child),
        "the successor waits on the moved child",
      );
      const runId = yield* finishChild(child);
      // [F] recorded(S, a), class E.
      const recorded = yield* recordedTask(successor, child, runId);
      assert.isDefined(recorded, "the successor records the child's result");
      assert.isTrue(notifiable(recorded));
      assert.isTrue(outcome.ok);
      // [N] the predecessor's task was closed by the move, not by the result.
      const old = (yield* orchestrator.getThreadProjection(predecessor)).subagents.find(
        (task) => task.childThreadId === child,
      )!;
      assert.equal(old.transferredTo?.threadId, successor);
      assert.equal(old.completionDelivery?.state, "disposed");
    }),
  );

  it.effect("2: a finished child whose result waited on the predecessor moves with it", () =>
    Effect.gen(function* () {
      const { predecessor, successor, child } = yield* setup("t2", {
        completionWake: "settled_only",
      });
      const runId = yield* finishChild(child);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const waiting = (yield* orchestrator.getThreadProjection(predecessor)).subagents.find(
        (task) => task.childThreadId === child,
      )!;
      // Settled_only behind P's live turn: the result waits, undelivered.
      assert.isTrue(
        waiting.completionDelivery === undefined || waiting.completionDelivery.state === "pending",
      );
      const outcome = yield* takeover(predecessor, successor);
      // [F] recorded(S, a), class E.
      const recorded = yield* recordedTask(successor, child, runId);
      assert.isDefined(recorded, "the successor records the waiting result");
      assert.equal(recorded?.resultRunId, runId);
      assert.isTrue(notifiable(recorded));
      assert.isTrue(outcome.ok);
      // [N] no new claim on the predecessor: its waiting delivery is disposed.
      const old = (yield* orchestrator.getThreadProjection(predecessor)).subagents.find(
        (task) => task.id === waiting.id,
      )!;
      assert.equal(old.completionDelivery?.state, "disposed");
      // [N] a repeat call returns the stored result.
      const repeat = yield* takeover(predecessor, successor);
      assert.deepEqual(repeat, outcome);
    }),
  );

  it.effect("7: a successor lock held past the deadline times out and changes nothing", () =>
    Effect.gen(function* () {
      const { predecessor, successor, child } = yield* setup("t7");
      const release = yield* holdLocks([successor]);
      const started = DateTime.toEpochMillis(yield* DateTime.now);
      const begun = yield* attemptBegun(predecessor);
      const attempt = yield* Effect.forkChild(takeover(predecessor, successor));
      yield* Fiber.join(begun);
      yield* TestClock.adjust("31 seconds");
      const outcome = yield* Fiber.join(attempt);
      // [G] the call returns within deadline + 2 s.
      assert.isAtMost(DateTime.toEpochMillis(yield* DateTime.now) - started, 32_000);
      yield* release;
      // [G] the child's result still reaches the predecessor.
      const runId = yield* finishChild(child);
      assert.isTrue(notifiable(yield* recordedTask(predecessor, child, runId)));
      // [N] timed_out on P, no ownership on C.
      assert.deepInclude(outcome, { ok: false, code: "takeover_timeout" });
      const record = (yield* thread(predecessor)).continuedBy;
      assert.equal(record?.state, "timed_out");
      assert.isUndefined((yield* thread(child)).ownership);
      // [N] a retry is attempt k+1 and takes over.
      const retry = yield* takeover(predecessor, successor);
      assert.isTrue(retry.ok);
      const effective = (yield* thread(predecessor)).continuedBy;
      assert.equal(effective?.state, "effective");
      assert.equal(effective?.attempt, (record?.attempt ?? 0) + 1);
      // [N] CAS: the earlier attempt's late timeout changes nothing.
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "thread.takeover.timeout",
        commandId: CommandId.make("t7-late-timeout"),
        threadId: predecessor,
        successorThreadId: successor,
        transferId: record!.transferId,
        attempt: record!.attempt,
        deadlineAt: record!.deadlineAt,
      } as never);
      assert.deepEqual((yield* thread(predecessor)).continuedBy, effective);
    }),
  );

  it.effect("7: an expired attempt record does not block the next attempt", () =>
    Effect.gen(function* () {
      yield* requireTakeover;
      const { predecessor, successor } = yield* setup("t7-expired");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const now = yield* DateTime.now;
      // [N] only: the transfer id is the branch's (P, S, launch command) hash.
      const { takeoverTransferId } = yield* Effect.promise(() => import("./ThreadTakeover.ts"));
      const transferId = takeoverTransferId(
        predecessor,
        successor,
        CommandId.make(`launch:${successor}`),
      );
      // A crash between begin and commit leaves an inert attempting record, here already expired.
      yield* orchestrator.dispatch({
        type: "thread.takeover.begin",
        commandId: CommandId.make("t7-expired-leftover"),
        threadId: predecessor,
        successorThreadId: successor,
        transferId,
        attempt: 9,
        deadlineAt: DateTime.subtract(now, { seconds: 1 }),
      } as never);
      const retry = yield* takeover(predecessor, successor);
      assert.isTrue(retry.ok);
      const record = (yield* thread(predecessor)).continuedBy;
      assert.equal(record?.state, "effective");
      assert.equal(record?.attempt, 10);
    }),
  );

  it.effect("7/7b: one try-lock miss, a joining call, one attempt and one deadline", () =>
    Effect.gen(function* () {
      const { predecessor, successor, child } = yield* setup("t7b");
      yield* requireTakeover;
      const probe = yield* takeoverProbe;
      const release = yield* holdLocks([child]);
      const first = yield* Effect.forkChild(probe.observe(takeover(predecessor, successor)));
      // The first try misses C and pauses on the (test) clock, holding nothing.
      yield* Deferred.await(probe.missed);
      const begun = (yield* thread(predecessor)).continuedBy!;
      // [N] a distinct concurrent call from the same S joins the attempt.
      const second = yield* Effect.forkChild(probe.observe(takeover(predecessor, successor)));
      yield* Deferred.await(probe.joined);
      yield* release;
      yield* TestClock.adjust("1 second");
      const executing = yield* Fiber.join(first);
      const joined = yield* Fiber.join(second);
      const { misses } = probe;
      // [G] effective with the original attempt and deadline; the executing call never awaited itself.
      assert.isTrue(executing.ok, JSON.stringify(executing));
      assert.deepEqual(joined, executing);
      const record = (yield* thread(predecessor)).continuedBy!;
      assert.equal(record.state, "effective");
      assert.equal(record.attempt, begun.attempt);
      assert.equal(record.transferId, begun.transferId);
      assert.isTrue(DateTime.Equivalence(record.deadlineAt, begun.deadlineAt));
      // [N] exactly one miss, on C.
      assert.deepEqual(misses, [child]);
      assert.equal(ownerOf(yield* thread(child)), successor);
    }),
  );

  it.effect("13: two successors race for one predecessor; one takes over", () =>
    Effect.gen(function* () {
      const {
        predecessor,
        successors: [first, second],
        child,
      } = yield* setup("t13-race", { successors: 2 });
      const release = yield* holdLocks([child]);
      const begun = yield* attemptBegun(predecessor);
      const one = yield* Effect.forkChild(takeover(predecessor, first!));
      yield* Fiber.join(begun);
      const other = yield* takeover(predecessor, second!);
      yield* release;
      yield* TestClock.adjust("1 second");
      const winner = yield* Fiber.join(one);
      // [F] one effective owner, the other conflicts.
      assert.equal(ownerOf(yield* thread(child)), first);
      assert.isTrue(winner.ok);
      assert.deepInclude(other, { ok: false, code: "takeover_conflict" });
      const late = yield* takeover(predecessor, second!);
      assert.deepInclude(late, { ok: false, code: "takeover_conflict" });
    }),
  );

  const lockOrders = [
    // [P source, children, successor]: the handoff pair path when P is the source.
    { name: "handoff pair P->C->S", order: (p: ThreadId, s: ThreadId, c: ThreadId) => [p, c, s] },
    // S as source with P as its successor, both id orders.
    { name: "reversed pair S->P", order: (p: ThreadId, s: ThreadId) => [s, p] },
    { name: "pair P->S", order: (p: ThreadId, s: ThreadId) => [p, s] },
    // A follow-up send to C, Stop of C and finalize of C take the owner, then C.
    {
      name: "follow-up, stop or finalize of C",
      order: (p: ThreadId, _s: ThreadId, c: ThreadId) => [p, c],
    },
    // A question's wake takes the parent.
    { name: "question forwarding", order: (p: ThreadId) => [p] },
    { name: "delete of P", order: (p: ThreadId) => [p], deletion: true },
    { name: "delete of S", order: (_p: ThreadId, s: ThreadId) => [s], deletion: true },
    {
      name: "delete of C",
      order: (_p: ThreadId, _s: ThreadId, c: ThreadId) => [c],
      deletion: true,
    },
  ] as const;

  it.effect.each(lockOrders)("8: takeover against $name ends with one owner", (scenario) =>
    Effect.gen(function* () {
      const name = `t8-${scenario.name.replace(/[^a-z]+/gi, "-")}`;
      const { predecessor, successor, child } = yield* setup(name);
      const started = DateTime.toEpochMillis(yield* DateTime.now);
      const release = yield* holdLocks(scenario.order(predecessor, successor, child), {
        deletion: "deletion" in scenario,
      });
      const attempt = yield* Effect.forkChild(takeover(predecessor, successor));
      yield* TestClock.adjust("2 seconds");
      yield* release;
      yield* TestClock.adjust("2 seconds");
      const outcome = yield* Fiber.join(attempt);
      // [G] bounded by the deadline.
      assert.isAtMost(DateTime.toEpochMillis(yield* DateTime.now) - started, 30_000);
      // [F] exactly one owner, the successor, and it records the result.
      assert.equal(ownerOf(yield* thread(child)), successor, JSON.stringify(outcome));
      const runId = yield* finishChild(child);
      assert.isTrue(notifiable(yield* recordedTask(successor, child, runId)));
    }),
  );

  it.effect("12 H: a result the predecessor already received is recorded without a wake", () =>
    Effect.gen(function* () {
      const { predecessor, successor, child } = yield* setup("t12-h");
      const runId = yield* finishChild(child);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const delivered = (yield* orchestrator.getThreadProjection(predecessor)).subagents.find(
        (task) => task.childThreadId === child,
      )!;
      yield* orchestrator.dispatch({
        type: "delegated_task.completion-delivery.acknowledge",
        commandId: CommandId.make("t12-h-ack"),
        parentThreadId: predecessor,
        taskId: delivered.id,
        observedByRunId: (yield* orchestrator.getThreadProjection(predecessor)).runs[0]!.id,
      });
      const before = (yield* orchestrator.getThreadProjection(predecessor)).subagents.find(
        (task) => task.id === delivered.id,
      )!;
      assert.equal(before.completionDelivery?.state, "acknowledged");
      const outcome = yield* takeover(predecessor, successor);
      // [F] class H: moved to S, recorded there and disposed, P's receipt unchanged.
      assert.equal(ownerOf(yield* thread(child)), successor);
      const recorded = yield* recordedTask(successor, child, runId);
      assert.isDefined(recorded);
      assert.equal(recorded?.completionDelivery?.state, "disposed");
      const after = (yield* orchestrator.getThreadProjection(predecessor)).subagents.find(
        (task) => task.id === delivered.id,
      )!;
      assert.deepEqual(after.completionDelivery, before.completionDelivery);
      assert.isTrue(outcome.ok && outcome.result.alreadyDeliveredToPredecessor.includes(child));
    }),
  );

  it.effect.each(["stop", "delete"] as const)(
    "12 X: after a user %s of the successor the result is recorded there without a wake",
    (ending) =>
      Effect.gen(function* () {
        const { predecessor, successor, child } = yield* setup(`t12-x-${ending}`);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* takeover(predecessor, successor);
        if (ending === "stop")
          yield* orchestrator.dispatch({
            type: "thread.stop",
            commandId: CommandId.make(`t12-x-${ending}-stop`),
            threadId: successor,
          } as never);
        else
          yield* orchestrator.dispatch({
            type: "thread.delete",
            commandId: CommandId.make(`t12-x-${ending}-delete`),
            threadId: successor,
          });
        const runsBefore = (yield* orchestrator.getThreadProjection(successor)).runs.length;
        const runId = yield* finishChild(child);
        // Restart twice: recovery runs again over the same state.
        yield* orchestrator.recoverDelegatedTasks;
        yield* orchestrator.recoverDelegatedTasks;
        // [F] class X: recorded on S, disposed, and S is not woken.
        const recorded = yield* recordedTask(successor, child, runId);
        assert.isDefined(recorded);
        assert.equal(recorded?.completionDelivery?.state, "disposed");
        assert.equal((yield* orchestrator.getThreadProjection(successor)).runs.length, runsBefore);
      }),
  );
});

/**
 * The branch's fault-injection seam (`ThreadTakeoverProbe`), declared here by its key so this file
 * also loads on cc15112571, where nothing reads it. Tests set the mutable hooks below.
 */
type OwnerSeen = "check" | "moved" | "stale";
const probe = {
  ownerRead: (_child: ThreadId, _owner: ThreadId): Effect.Effect<void> => Effect.void,
  ownerLocked: (_child: ThreadId, _owner: ThreadId): Effect.Effect<OwnerSeen> =>
    Effect.succeed("check"),
  beforeForwardCommit: (_input: {
    readonly childThreadId: ThreadId;
  }): Effect.Effect<void, string> => Effect.void,
  reconcilerPassed: (): Effect.Effect<void> => Effect.void,
  taskBindingRead: (_taskId: string, _childThreadId: ThreadId): Effect.Effect<void> => Effect.void,
  waitChildSettled: (_taskId: string, _childThreadId: ThreadId): Effect.Effect<void> => Effect.void,
};
const resetProbe = () => {
  probe.ownerRead = () => Effect.void;
  probe.ownerLocked = () => Effect.succeed("check");
  probe.beforeForwardCommit = () => Effect.void;
  probe.reconcilerPassed = () => Effect.void;
  probe.taskBindingRead = () => Effect.void;
  probe.waitChildSettled = () => Effect.void;
};
const TakeoverProbe = Context.Reference<typeof probe>("t3/orchestration-v2/ThreadTakeoverProbe", {
  defaultValue: () => probe,
});
// Merged: the reactors read it from the layer, a test-driven worker from the test's context.
const layerProbe = Layer.succeed(TakeoverProbe, {
  ownerRead: (child, owner) => Effect.suspend(() => probe.ownerRead(child, owner)),
  ownerLocked: (child, owner) => Effect.suspend(() => probe.ownerLocked(child, owner)),
  beforeForwardCommit: (input) => Effect.suspend(() => probe.beforeForwardCommit(input)),
  reconcilerPassed: () => Effect.suspend(() => probe.reconcilerPassed()),
  taskBindingRead: (taskId, child) => Effect.suspend(() => probe.taskBindingRead(taskId, child)),
  waitChildSettled: (taskId, child) => Effect.suspend(() => probe.waitChildSettled(taskId, child)),
});
const layerForwardTest = layerTest.pipe(Layer.provideMerge(layerProbe));

/** Started before an action: completes on the first stored event the filter accepts. */
const awaitStoredEvent = (filter: (event: OrchestrationV2DomainEvent) => boolean) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const afterSequence = yield* sink.latestSequence();
    const fiber = yield* sink.stream({ afterSequence }).pipe(
      Stream.filter((stored) => filter(stored.event)),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkChild,
    );
    // Bounded in real time, so a build without the behaviour fails on the next assertion.
    return TestClock.withLive(Fiber.join(fiber).pipe(Effect.timeoutOption("5 seconds")));
  });

/** Ends C's latest run as the provider would, without waiting for its result (`snapshot`: see finishChild). */
const endChildRun = (
  child: ThreadId,
  status: "completed" | "failed" = "completed",
  snapshot?: OrchestrationV2Run,
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const latest = (yield* orchestrator.getThreadProjection(child)).runs.toSorted(
      (a, b) => b.ordinal - a.ordinal,
    )[0]!;
    const { delegatedCompletion: _delegatedCompletion, ...stale } = snapshot ?? latest;
    const run = snapshot === undefined ? latest : stale;
    yield* sink.write({
      events: [
        {
          id: EventId.make(`end:${run.id}:${status}`),
          type: "run.updated",
          threadId: child,
          runId: run.id,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: { ...run, status, completedAt: now },
        },
      ],
    });
    return run.id;
  });

/**
 * Settles every other effect as if the server had run it (the provider stubs here cannot), so
 * the worker runs only forwards. A child's earlier rows would otherwise block its lane.
 */
const parkOtherEffects = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* FixtureThreads;
  yield* sql`
    UPDATE orchestration_v2_effect_outbox SET status = 'cancelled', lease_owner = NULL
    WHERE status IN ('pending', 'running') AND effect_type != 'takeover.forward'
      ${threads === undefined ? sql`` : sql`AND ${sql.in("thread_id", threads)}`}
  `;
});

/** The effect worker, as the daemon runs it: drain, then wait (fake clock) for the next retry. */
const runEffects = Effect.gen(function* () {
  const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
  yield* parkOtherEffects;
  for (let round = 0; round < 12; round++) {
    yield* worker.drain();
    const next = yield* worker.nextClaimableAt();
    if (Option.isNone(next)) return;
    const wait = DateTime.toEpochMillis(next.value) - DateTime.toEpochMillis(yield* DateTime.now);
    yield* TestClock.adjust(Math.max(1, wait));
  }
});

/** Advances the fake clock past one live reconciler tick and waits for that pass to finish. */
const reconcilerTick = Effect.gen(function* () {
  const passed = yield* Deferred.make<void>();
  probe.reconcilerPassed = () => Deferred.succeed(passed, undefined).pipe(Effect.asVoid);
  yield* TestClock.adjust("70 seconds");
  yield* TestClock.withLive(Deferred.await(passed).pipe(Effect.timeoutOption("5 seconds")));
  probe.reconcilerPassed = () => Effect.void;
});

/** The open obligations for one child (branch only). */
const openObligations = (child: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const read = (store as { readonly getTakeoverObligations?: unknown }).getTakeoverObligations as
      | (() => Effect.Effect<ReadonlyArray<{ readonly childThreadId: ThreadId }>, Error>)
      | undefined;
    if (read === undefined) return assert.fail("[N]: this build has no obligations");
    return (yield* read().pipe(Effect.orDie)).filter((row) => row.childThreadId === child);
  });

/** The forward's outbox row and its command receipts. */
const forwardRows = (taskId: NodeId, runId: RunId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const effectId = `effect:takeover.forward:${taskId}:${runId}`;
    const rows = yield* sql<{
      readonly effect_id: string;
      readonly status: string;
      readonly attempt_count: number;
      readonly last_error: string | null;
    }>`SELECT effect_id, status, attempt_count, last_error FROM orchestration_v2_effect_outbox
      WHERE effect_id = ${effectId} OR effect_id LIKE ${`${effectId}:rearm:%`}`;
    const receipts = yield* sql<{ readonly command_id: string; readonly status: string }>`
      SELECT command_id, status FROM orchestration_command_receipts
      WHERE command_id LIKE ${`takeover.forward:${taskId}:${runId}:%`}`;
    return {
      current: rows.find((row) => row.effect_id === effectId),
      rearms: rows.filter((row) => row.effect_id !== effectId).length,
      receipts,
    };
  });

/** The subagent-results index answers nothing for these kinds while `effect` runs. */
const withoutResultIndex = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const store = (yield* ProjectionStore.ProjectionStoreV2) as {
      getRecoveryThreadIds: ProjectionStore.ProjectionStoreV2["Service"]["getRecoveryThreadIds"];
    };
    const original = store.getRecoveryThreadIds;
    store.getRecoveryThreadIds = (kind, projects) =>
      kind === "subagent-results" || String(kind) === "owned-subagent-results"
        ? Effect.succeed([])
        : original(kind, projects);
    return yield* effect.pipe(
      Effect.ensuring(Effect.sync(() => (store.getRecoveryThreadIds = original))),
    );
  });

/** C's original task on the predecessor. */
const predecessorTask = (predecessor: ThreadId, child: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.getThreadProjection(predecessor),
  ).pipe(
    Effect.map(
      (projection) =>
        projection.subagents.find(
          (task) =>
            task.childThreadId === child &&
            projection.thread.id === predecessor &&
            task.transferredTo !== undefined,
        ) ?? projection.subagents.find((task) => task.childThreadId === child)!,
    ),
  );

type Setup = Effect.Success<ReturnType<typeof setup>>;

/** The next 8 owner validations for `child` see the owner move; completes on the 8th. */
const flipOwnerEightTimes = (child: ThreadId) =>
  Effect.gen(function* () {
    let flips = 0;
    const exhausted = yield* Deferred.make<void>();
    probe.ownerLocked = (candidate) =>
      Effect.gen(function* () {
        if (candidate !== child || flips >= 8) return "check" as const;
        if (++flips === 8) yield* Deferred.succeed(exhausted, undefined);
        return "moved" as const;
      });
    return exhausted;
  });

/**
 * A holder of P's lock that read the owner before the takeover slips through after it (§3), so
 * C's result lands on P's moved task and G forwards it (left to the worker). The commit's rebind
 * reaction on S sees 8 owner flips and gives up, leaving the forward or the reconciler.
 */
const staleRouteResult = (s: Setup) =>
  Effect.gen(function* () {
    if (!(yield* hasTakeover)) {
      const runId = yield* finishChild(s.child);
      yield* takeover(s.predecessor, s.successor);
      return runId;
    }
    const read = yield* Deferred.make<void>();
    const go = yield* Deferred.make<void>();
    let latched = false;
    probe.ownerRead = (child, owner) =>
      child === s.child && owner === s.predecessor && !latched
        ? Effect.sync(() => {
            latched = true;
          }).pipe(
            Effect.andThen(Deferred.succeed(read, undefined)),
            Effect.andThen(Deferred.await(go)),
          )
        : Effect.void;
    let flips = 0;
    const exhausted = yield* Deferred.make<void>();
    probe.ownerLocked = (child, owner) =>
      Effect.gen(function* () {
        if (child !== s.child) return "check" as const;
        if (owner === s.predecessor) return "stale" as const;
        if (flips >= 8) return "check" as const;
        if (++flips === 8) yield* Deferred.succeed(exhausted, undefined);
        return "moved" as const;
      });
    const forwarded = yield* awaitStoredEvent(
      (event) =>
        event.type === "subagent.updated" &&
        event.threadId === s.predecessor &&
        event.payload.childThreadId === s.child &&
        (event.payload.transferredTo?.forwards?.length ?? 0) > 0,
    );
    const runId = yield* endChildRun(s.child);
    yield* Deferred.await(read);
    const outcome = yield* takeover(s.predecessor, s.successor);
    assert.isTrue(outcome.ok, JSON.stringify(outcome));
    yield* Deferred.succeed(go, undefined);
    yield* forwarded;
    yield* Deferred.await(exhausted);
    resetProbe();
    return runId;
  });

/** T, launched by S, with its own running turn. */
const seedSuccessorOf = (s: Setup, name: string) =>
  Effect.gen(function* () {
    const thread = ThreadId.make(`${name}-t`);
    yield* seedThread({
      threadId: thread,
      projectId: ProjectId.make(`${name}-project`),
      launchedBy: s.successor,
    });
    return thread;
  });

/** P's queued wake for its claimed results, as the provider continuation would queue it. */
const queuePredecessorWake = (s: Setup, name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const delivery = (yield* orchestrator.getThreadProjection(s.predecessor)).runs.find(
      (run) => run.id === s.predecessorRunId,
    )!.delegatedCompletion!.delivery!;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      createdBy: "agent",
      creationSource: "server",
      commandId: CommandId.make(`${name}-wake`),
      threadId: s.predecessor,
      messageId: delivery.messageId,
      text: "Delegated tasks completed",
      attachments: [],
      modelSelection,
      dispatchMode: { type: "queue_after_active" },
      delegatedCompletion: {
        parentRunId: s.predecessorRunId,
        generation: delivery.generation,
        taskIds: delivery.taskIds,
      },
    });
    return (yield* orchestrator.getThreadProjection(s.predecessor)).runs.find(
      (run) => run.userMessageId === delivery.messageId,
    )!.id;
  });

/** P's wake turn started and was then cancelled (not a user cancel of the queued wake). */
const cancelWakeTurn = (threadId: ThreadId, runId: RunId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
      (candidate) => candidate.id === runId,
    )!;
    yield* sink.write({
      events: [
        {
          id: EventId.make(`cancel-wake:${runId}`),
          type: "run.updated",
          threadId,
          runId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: { ...run, status: "cancelled", startedAt: now, completedAt: now },
        },
      ],
    });
  });

/** C's latest run gets an assistant reply, the text its result is built from. */
const replyOnChild = (child: ThreadId, text: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const run = (yield* orchestrator.getThreadProjection(child)).runs.toSorted(
      (a, b) => b.ordinal - a.ordinal,
    )[0]!;
    yield* sink.write({
      events: [
        {
          id: EventId.make(`reply:${run.id}`),
          type: "message.updated",
          threadId: child,
          runId: run.id,
          occurredAt: now,
          payload: {
            id: MessageId.make(`reply:${run.id}`),
            threadId: child,
            runId: run.id,
            nodeId: null,
            role: "assistant",
            text,
            attachments: [],
            streaming: false,
            createdBy: "agent",
            creationSource: "server",
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
    });
    return run.id;
  });

/** Started before an action: completes once `holder` records C's result `text`. */
const awaitResultText = (holder: ThreadId, child: ThreadId, text: string) =>
  awaitStoredEvent(
    (event) =>
      event.type === "subagent.updated" &&
      event.threadId === holder &&
      event.payload.childThreadId === child &&
      event.payload.result === text,
  );

/** A third thread Q sends C a new turn; slice A records no task for it (display only). */
const thirdPartyTurn = (s: Setup, name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sender = ThreadId.make(`${name}-q`);
    yield* seedThread({ threadId: sender, projectId: ProjectId.make(`${name}-project`) });
    const messageId = MessageId.make(`${name}-q-turn`);
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`${name}-q-turn`),
      threadId: s.child,
      messageId,
      text: "Also check the other branch.",
      attachments: [],
      modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "mcp",
      senderThreadId: sender,
    } as never);
    return (yield* orchestrator.getThreadProjection(s.child)).runs.find(
      (run) => run.userMessageId === messageId,
    )!;
  });

const layerForwardTestWithQuestions = DelegatedTaskQuestionReactor.layer.pipe(
  Layer.provideMerge(layerForwardTest),
);

it.layer(layerForwardTestWithQuestions)("thread takeover guard, forward and reconciler", (it) => {
  it.effect("4 (§4): a question open at the takeover is forwarded to the successor once", () =>
    Effect.gen(function* () {
      const s = yield* setup("tq");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const reactor = yield* DelegatedTaskQuestionReactor.DelegatedTaskQuestionReactor;
      const now = yield* DateTime.now;
      const childRun = (yield* orchestrator.getThreadProjection(s.child)).runs[0]!;
      const question = {
        id: EventId.make("tq-question"),
        type: "runtime-request.updated",
        threadId: s.child,
        runId: childRun.id,
        occurredAt: now,
        payload: {
          id: RuntimeRequestId.make("tq-request"),
          nodeId: childRun.rootNodeId!,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "message" },
          createdAt: now,
          resolvedAt: null,
        },
      } satisfies OrchestrationV2DomainEvent;
      yield* sink.write({ events: [question] });
      yield* reactor.handle(question);
      const questionWakes = (threadId: ThreadId) =>
        Effect.map(orchestrator.getThreadProjection(threadId), (projection) =>
          projection.messages.filter(
            (message) => message.notification !== undefined && message.text.includes("tq-request"),
          ),
        );
      assert.equal((yield* questionWakes(s.predecessor)).length, 1, "forwarded to P first");
      yield* takeover(s.predecessor, s.successor);
      const moved = {
        id: EventId.make("tq-moved"),
        type: "thread.metadata-updated",
        threadId: s.child,
        occurredAt: now,
        payload: yield* thread(s.child),
      } satisfies OrchestrationV2DomainEvent;
      yield* reactor.handle(moved);
      yield* reactor.handle(moved);
      // [F] the successor gets the open question, once; P's copy may stay.
      assert.equal((yield* questionWakes(s.successor)).length, 1, "re-forwarded to S once");
    }),
  );

  it.effect(
    "3: a grandfathered predecessor wake, cancelled after the takeover, is never re-claimed",
    () =>
      Effect.gen(function* () {
        const s = yield* setup("t3");
        const runId = yield* finishChild(s.child);
        const wakeRunId = yield* queuePredecessorWake(s, "t3");
        const outcome = yield* takeover(s.predecessor, s.successor);
        // [F] recorded(S, a), class E.
        assert.isTrue(
          notifiable(yield* recordedTask(s.successor, s.child, runId)),
          "recorded(S) E",
        );
        assert.isTrue(outcome.ok);
        const old = yield* predecessorTask(s.predecessor, s.child);
        assert.equal(old.completionDelivery?.state, "claimed", "grandfathered claim left as is");
        const settled = yield* awaitStoredEvent(
          (event) =>
            event.type === "subagent.updated" &&
            event.payload.id === old.id &&
            event.payload.completionDelivery?.state !== "claimed",
        );
        yield* cancelWakeTurn(s.predecessor, wakeRunId);
        yield* settled;
        // [N] guard G: disposed, never claimed again on P; the attempt is owed to the owner.
        const after = yield* predecessorTask(s.predecessor, s.child);
        assert.equal(after.completionDelivery?.state, "disposed");
        assert.deepEqual(after.transferredTo?.forwards, [runId]);
        yield* runEffects;
        // [F] still recorded on S; [N] the forward was a no-op and the obligation is closed.
        const recorded = yield* recordedTask(s.successor, s.child, runId);
        assert.isTrue(notifiable(recorded));
        assert.equal(recorded?.resultRunId, runId);
        assert.deepEqual(yield* openObligations(s.child), []);
        assert.equal((yield* forwardRows(old.id, runId)).current?.status, "succeeded");
      }),
  );

  it.effect("4: the cancel after a second takeover S->T reaches T", () =>
    Effect.gen(function* () {
      const s = yield* setup("t4");
      const t = yield* seedSuccessorOf(s, "t4");
      const runId = yield* finishChild(s.child);
      const wakeRunId = yield* queuePredecessorWake(s, "t4");
      yield* takeover(s.predecessor, s.successor);
      yield* takeover(s.successor, t);
      yield* cancelWakeTurn(s.predecessor, wakeRunId);
      yield* runEffects;
      // [F] recorded(T, a), class E.
      const recorded = yield* recordedTask(t, s.child, runId);
      assert.isTrue(notifiable(recorded), "recorded(T) E");
      assert.equal(ownerOf(yield* thread(s.child)), t);
      yield* requireTakeover;
      assert.deepEqual(yield* openObligations(s.child), []);
    }),
  );

  it.effect("5: a stale route after the takeover is forwarded to the successor", () =>
    Effect.gen(function* () {
      const s = yield* setup("t5");
      const runId = yield* staleRouteResult(s);
      yield* runEffects;
      // [F] recorded(S, a), class E.
      const recorded = yield* recordedTask(s.successor, s.child, runId);
      assert.isTrue(notifiable(recorded), "recorded(S) E");
      yield* requireTakeover;
      // [N] exact attempt, and the obligation is closed by that record.
      assert.equal(recorded?.resultRunId, runId);
      assert.deepEqual(yield* openObligations(s.child), []);
    }),
  );

  it.effect.each(["pending", "running", "failed"] as const)(
    "6: a forward %s at a crash is recorded after restart, twice, without the results index",
    (row) =>
      Effect.gen(function* () {
        const s = yield* setup(`t6-${row}`);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const sink = yield* EventSink.EventSinkV2;
        if (row === "failed") probe.beforeForwardCommit = () => Effect.fail("injected fault");
        const runId = yield* staleRouteResult(s);
        if (row === "failed") probe.beforeForwardCommit = () => Effect.fail("injected fault");
        const taskId = (yield* predecessorTask(s.predecessor, s.child)).id;
        if (row === "running") {
          // The worker claimed it, then the process died.
          yield* parkOtherEffects;
          yield* outbox.claimNext({ workerId: "worker:lost" });
        }
        if (row === "failed") {
          yield* runEffects;
          resetProbe();
        }
        // Restart twice: process-loss reconcile, then recovery, with the index answering nothing.
        yield* outbox.reconcileAfterProcessLoss;
        if (row === "running" && (yield* hasTakeover))
          // [N] the effect type is replay-safe: requeued, not cancelled.
          assert.equal((yield* forwardRows(taskId, runId)).current?.status, "pending");
        yield* withoutResultIndex(orchestrator.recoverDelegatedTasks);
        const afterFirst = yield* sink.latestSequence();
        yield* outbox.reconcileAfterProcessLoss;
        yield* withoutResultIndex(orchestrator.recoverDelegatedTasks);
        // [F] recorded(S, a) after restart.
        const recorded = yield* recordedTask(s.successor, s.child, runId);
        assert.isTrue(notifiable(recorded), "recorded(S) E after restart");
        yield* requireTakeover;
        // [N] the second restart wrote nothing new; the leftover row is a no-op.
        assert.equal(yield* sink.latestSequence(), afterFirst);
        assert.equal(recorded?.resultRunId, runId);
        yield* runEffects;
        assert.deepEqual(yield* openObligations(s.child), []);
      }).pipe(Effect.ensuring(Effect.sync(resetProbe))),
  );

  it.effect.each(["successor", "predecessor"] as const)(
    "9: a follow-up the %s sends after the takeover reports to the successor",
    (sender) =>
      Effect.gen(function* () {
        const s = yield* setup(`t9-${sender}`);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* finishChild(s.child);
        yield* takeover(s.predecessor, s.successor);
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`t9-${sender}-follow-up`),
          threadId: s.child,
          messageId: MessageId.make(`t9-${sender}-follow-up`),
          text: "One more check, please.",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
          creationSource: "mcp",
          senderThreadId: sender === "successor" ? s.successor : s.predecessor,
        } as never);
        const runId = yield* finishChild(s.child);
        // [F] recorded(S, a), class E.
        assert.isTrue(
          notifiable(yield* recordedTask(s.successor, s.child, runId)),
          "recorded(S) E",
        );
      }),
  );

  it.effect("11: the predecessor's old task id cannot stop the moved child", () =>
    Effect.gen(function* () {
      const s = yield* setup("t11-old-cancel");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* takeover(s.predecessor, s.successor);
      const before = (yield* orchestrator.getThreadProjection(s.child)).runs.at(-1)!.status;
      const cancelled = yield* orchestrator
        .cancelDelegatedTask({
          parentThreadId: s.predecessor,
          taskId: s.taskId,
          command: {
            type: "thread.stop",
            commandId: CommandId.make("t11-old-cancel"),
            threadId: s.child,
            stopDelegatedTasks: false,
          },
          stopDescendants: () => Effect.void,
        })
        .pipe(Effect.exit);
      // [F] refused as transferred, and C keeps running.
      assert.isTrue(
        cancelled._tag === "Failure" && String(cancelled.cause).includes("transferred"),
        String(cancelled),
      );
      assert.equal((yield* orchestrator.getThreadProjection(s.child)).runs.at(-1)!.status, before);
    }),
  );

  it.effect("11: cancelling the anchor on the successor stops the child", () =>
    Effect.gen(function* () {
      const s = yield* setup("t11-anchor-cancel");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const outcome = yield* takeover(s.predecessor, s.successor);
      const anchorTaskId = outcome.ok
        ? (
            outcome.result as unknown as {
              readonly migrated: ReadonlyArray<{ readonly anchorTaskId: NodeId }>;
            }
          ).migrated[0]!.anchorTaskId
        : s.taskId;
      yield* orchestrator
        .cancelDelegatedTask({
          parentThreadId: s.successor,
          taskId: anchorTaskId,
          command: {
            type: "thread.stop",
            commandId: CommandId.make("t11-anchor-cancel"),
            threadId: s.child,
            stopDelegatedTasks: false,
          },
          stopDescendants: () => Effect.void,
        })
        .pipe(Effect.exit);
      // [F] the anchor carries the cancel marker and C's run stopped.
      const anchor = (yield* orchestrator.getThreadProjection(s.successor)).subagents.find(
        (task) => task.id === anchorTaskId,
      );
      assert.isDefined(anchor?.cancelledRunId, "the anchor records the cancel");
      const run = (yield* orchestrator.getThreadProjection(s.child)).runs.at(-1)!;
      assert.notInclude(["starting", "running", "queued"], run.status);
    }),
  );

  it.effect("11: a child failing on its own after the takeover reports the failure to S", () =>
    Effect.gen(function* () {
      const s = yield* setup("t11-failed");
      yield* takeover(s.predecessor, s.successor);
      const runId = yield* finishChild(s.child, "failed");
      // [F] recorded(S, a), class E, with the failed result.
      const recorded = yield* recordedTask(s.successor, s.child, runId);
      assert.isTrue(notifiable(recorded), "recorded(S) E");
      assert.equal(recorded?.status, "failed");
    }),
  );

  it.effect("15: a failed forward is re-armed live and records the exact attempt", () =>
    Effect.gen(function* () {
      for (const second of [false, true]) {
        const s = yield* setup(`t15-${second ? "t" : "s"}`);
        const t = second ? yield* seedSuccessorOf(s, "t15-t") : undefined;
        const fault = () => Effect.fail("injected fault");
        const runId = yield* staleRouteResult(s);
        const taskId = (yield* predecessorTask(s.predecessor, s.child)).id;
        // All five executions fail before the command commits.
        probe.beforeForwardCommit = fault;
        yield* withoutResultIndex(runEffects);
        if (yield* hasTakeover) {
          const failed = yield* forwardRows(taskId, runId);
          assert.equal(failed.current?.status, "failed");
          // [N] no receipt for the failed tries.
          assert.deepEqual(failed.receipts, []);
        }
        if (t !== undefined) {
          // The second commit rebinds C's run to T's anchor; that reaction's owner flips 8 times
          // too, so only the re-armed forward can record on T.
          const exhausted = yield* flipOwnerEightTimes(s.child);
          yield* takeover(s.successor, t);
          if (yield* hasTakeover) yield* Deferred.await(exhausted);
        }
        resetProbe();
        // No restart and no recovery call: only the clock moves, past the re-arm spacing.
        yield* withoutResultIndex(
          Effect.gen(function* () {
            yield* reconcilerTick;
            yield* reconcilerTick;
            yield* runEffects;
          }),
        );
        // [F] recorded(owner, exact a).
        const owner = t ?? s.successor;
        const recorded = yield* recordedTask(owner, s.child, runId);
        assert.isTrue(notifiable(recorded), `recorded(${owner}) E`);
        yield* requireTakeover;
        assert.equal(recorded?.resultRunId, runId);
        const rows = yield* forwardRows(taskId, runId);
        assert.isAtLeast(rows.rearms, 1, "re-armed by the live reconciler");
        assert.equal(rows.current?.status, "succeeded");
        assert.deepEqual(yield* openObligations(s.child), []);
      }
    }).pipe(Effect.ensuring(Effect.sync(resetProbe))),
  );

  it.effect("15b: owner churn exhausts the forward as a retryable error, never a success", () =>
    Effect.gen(function* () {
      for (const second of [false, true]) {
        const s = yield* setup(`t15b-${second ? "t" : "s"}`);
        const t = second ? yield* seedSuccessorOf(s, "t15b-t") : undefined;
        const runId = yield* staleRouteResult(s);
        if (t !== undefined) yield* takeover(s.successor, t);
        const taskId = (yield* predecessorTask(s.predecessor, s.child)).id;
        // The owner flips on all 8 validations of the first forward execution, then settles.
        let flips = 0;
        probe.ownerLocked = (child) =>
          Effect.succeed(child === s.child && flips < 8 ? (flips++, "moved") : "check");
        yield* withoutResultIndex(runEffects);
        resetProbe();
        // [F] recorded(owner, exact a), no restart and no recovery call.
        const owner = t ?? s.successor;
        const recorded = yield* recordedTask(owner, s.child, runId);
        assert.isTrue(notifiable(recorded), `recorded(${owner}) E`);
        yield* requireTakeover;
        assert.equal(flips, 8);
        assert.equal(recorded?.resultRunId, runId);
        const rows = yield* forwardRows(taskId, runId);
        // [N] the exhausted try was a retry, not a success: two executions, one receipt.
        assert.equal(rows.current?.status, "succeeded");
        assert.equal(rows.current?.attempt_count, 2);
        assert.equal(rows.receipts.length, 1);
        assert.deepEqual(yield* openObligations(s.child), []);
      }
    }).pipe(Effect.ensuring(Effect.sync(resetProbe))),
  );

  it.effect("15b: an open obligation behind a succeeded row is re-armed within one tick", () =>
    Effect.gen(function* () {
      yield* requireTakeover;
      const s = yield* setup("t15b-forced");
      const sql = yield* SqlClient.SqlClient;
      const runId = yield* staleRouteResult(s);
      const taskId = (yield* predecessorTask(s.predecessor, s.child)).id;
      // Forced: the row claims success although the owner never recorded the attempt.
      yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'succeeded'
        WHERE effect_id = ${`effect:takeover.forward:${taskId}:${runId}`}`;
      assert.equal((yield* openObligations(s.child)).length, 1);
      yield* withoutResultIndex(reconcilerTick);
      // [N] one tick later the obligation has a fresh pending row.
      const rows = yield* forwardRows(taskId, runId);
      assert.equal(rows.current?.status, "pending");
      assert.equal(rows.rearms, 1);
      yield* withoutResultIndex(runEffects);
      const recorded = yield* recordedTask(s.successor, s.child, runId);
      assert.equal(recorded?.resultRunId, runId);
      assert.deepEqual(yield* openObligations(s.child), []);
    }),
  );

  it.effect("16: a transient failure in the startup repair re-arms the row and records live", () =>
    Effect.gen(function* () {
      const s = yield* setup("t16");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const runId = yield* staleRouteResult(s);
      const taskId = (yield* predecessorTask(s.predecessor, s.child)).id;
      // Before the crash every execution failed, so the row is failed.
      probe.beforeForwardCommit = () => Effect.fail("injected fault");
      yield* withoutResultIndex(runEffects);
      // Restart: the inline repair fails once more, then the fault clears.
      let failures = 1;
      probe.beforeForwardCommit = () =>
        failures-- > 0 ? Effect.fail("transient fault") : Effect.void;
      yield* outbox.reconcileAfterProcessLoss;
      yield* withoutResultIndex(orchestrator.recoverDelegatedTasks);
      if (yield* hasTakeover) {
        const rearmed = yield* forwardRows(taskId, runId);
        // [N] the inline failure left durable work: a fresh pending row.
        assert.equal(rearmed.current?.status, "pending");
        assert.equal(rearmed.rearms, 1);
      }
      // Without a second restart, the worker records it.
      yield* withoutResultIndex(runEffects);
      // [F] recorded(owner, exact a).
      const recorded = yield* recordedTask(s.successor, s.child, runId);
      assert.isTrue(notifiable(recorded), "recorded(S) E");
      yield* requireTakeover;
      assert.equal(recorded?.resultRunId, runId);
      assert.deepEqual(yield* openObligations(s.child), []);
    }).pipe(Effect.ensuring(Effect.sync(resetProbe))),
  );

  it.effect("17: owner churn during the live terminal reaction is finished by the reconciler", () =>
    Effect.gen(function* () {
      const s = yield* setup("t17");
      yield* takeover(s.predecessor, s.successor);
      let flips = 0;
      const exhausted = yield* Deferred.make<void>();
      probe.ownerLocked = (child) =>
        Effect.gen(function* () {
          if (child !== s.child || flips >= 8) return "check" as const;
          flips++;
          if (flips === 8) yield* Deferred.succeed(exhausted, undefined);
          return "moved" as const;
        });
      yield* endChildRun(s.child);
      const runId = (yield* Orchestrator.OrchestratorV2.pipe(
        Effect.flatMap((orchestrator) => orchestrator.getThreadProjection(s.child)),
      )).runs.toSorted((a, b) => b.ordinal - a.ordinal)[0]!.id;
      if (yield* hasTakeover) {
        yield* Deferred.await(exhausted);
        resetProbe();
        yield* reconcilerTick;
      }
      // [F] recorded(owner) through reconciler (ii), no restart and no recovery call.
      const recorded = yield* recordedTask(s.successor, s.child, runId);
      assert.isTrue(notifiable(recorded), "recorded(S) E");
      assert.equal(flips, 8);
    }).pipe(Effect.ensuring(Effect.sync(resetProbe))),
  );

  it.effect("18: a backing-off forward on C's lane does not hold up S's continuation", () =>
    Effect.gen(function* () {
      const s = yield* setup("t18");
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const takeoverBuild = yield* hasTakeover;
      yield* parkOtherEffects;
      // A row on C's lane that keeps backing off: on .23 any C effect, here a forward.
      yield* outbox.enqueue([
        {
          id: "t18-child-lane",
          commandId: CommandId.make("t18-child-lane"),
          threadId: s.child,
          request: takeoverBuild
            ? {
                type: "takeover.forward",
                childThreadId: s.child,
                sourceThreadId: s.predecessor,
                sourceTaskId: s.taskId,
                attemptRunId: RunId.make("t18-attempt"),
              }
            : ({ type: "delegated-tasks.stop" } as never),
        } as never,
      ]);
      const claimed = yield* outbox.claimNext({ workerId: "t18" });
      assert.isTrue(Option.isSome(claimed));
      yield* outbox.retry({
        effectId: "t18-child-lane",
        workerId: "t18",
        error: "backing off",
        delayMs: 60_000,
      });
      yield* outbox.enqueue([
        {
          id: "t18-successor-continue",
          commandId: CommandId.make("t18-successor-continue"),
          threadId: s.successor,
          request: {
            type: "provider-runtime.continue",
            sourceRunId: RunId.make(`run:${s.successor}`),
          },
        },
      ]);
      // [G] S's continuation is claimable at once.
      const next = yield* outbox.claimNext({ workerId: "t18" });
      assert.equal(Option.getOrUndefined(next)?.id, "t18-successor-continue");
      yield* outbox.fail({ effectId: "t18-successor-continue", workerId: "t18", error: "test" });
    }),
  );

  it.effect(
    "18: a forward with no resolvable owner anchor fails with no events and no receipt",
    () =>
      Effect.gen(function* () {
        yield* requireTakeover;
        const s = yield* setup("t18-anchor");
        const sql = yield* SqlClient.SqlClient;
        const sink = yield* EventSink.EventSinkV2;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const runId = yield* staleRouteResult(s);
        const taskId = (yield* predecessorTask(s.predecessor, s.child)).id;
        const anchorTaskId = (yield* thread(s.child)).ownership!.anchorTaskId;
        // The owner's anchor row is lost.
        yield* sql`DELETE FROM orchestration_v2_projection_subagents WHERE subagent_id = ${anchorTaskId}`;
        const before = yield* sink.latestSequence();
        const forwarded = yield* (
          orchestrator as unknown as {
            readonly forwardTakeoverResult: (input: object) => Effect.Effect<void, Error>;
          }
        )
          .forwardTakeoverResult({
            childThreadId: s.child,
            sourceThreadId: s.predecessor,
            sourceTaskId: taskId,
            attemptRunId: runId,
          })
          .pipe(Effect.exit);
        // [N] fails as forward_target_unavailable, writes nothing, and the obligation stays open.
        assert.isTrue(
          forwarded._tag === "Failure" &&
            String(forwarded.cause).includes("forward_target_unavailable"),
          String(forwarded),
        );
        assert.equal(yield* sink.latestSequence(), before);
        assert.deepEqual((yield* forwardRows(taskId, runId)).receipts, []);
        assert.equal((yield* openObligations(s.child)).length, 1);
      }),
  );

  it.effect.each(["running", "finished", "running through S->T"] as const)(
    "B-8: a third thread's later turn %s at the takeover is recorded by its own attempt",
    (variant) =>
      Effect.gen(function* () {
        const name = `b8-${variant === "running" ? "live" : variant === "finished" ? "done" : "chain"}`;
        const s = yield* setup(name);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const sink = yield* EventSink.EventSinkV2;
        // a: P's own task finishes and P acknowledges it.
        yield* replyOnChild(s.child, "Result of a.");
        const aRecorded = yield* awaitResultText(s.predecessor, s.child, "Result of a.");
        yield* endChildRun(s.child);
        yield* aRecorded;
        yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make(`${name}-ack`),
          parentThreadId: s.predecessor,
          taskId: s.taskId,
          observedByRunId: s.predecessorRunId,
        });
        const receipt = yield* predecessorTask(s.predecessor, s.child);
        assert.equal(receipt.completionDelivery?.state, "acknowledged");
        // b: a real Q->C turn; no follow-up task records it.
        const b = yield* thirdPartyTurn(s, name);
        assert.isUndefined(b.delegatedTaskId);
        assert.lengthOf(
          (yield* orchestrator.getThreadProjection(s.predecessor)).subagents.filter(
            (task) => task.childThreadId === s.child,
          ),
          1,
          "the third thread's turn creates no task",
        );
        if (variant === "finished") {
          yield* replyOnChild(s.child, "Result of b.");
          yield* endChildRun(s.child);
        }
        const owner =
          variant === "running through S->T" ? yield* seedSuccessorOf(s, name) : s.successor;
        const outcome = yield* takeover(s.predecessor, s.successor);
        if (owner !== s.successor) yield* takeover(s.successor, owner);
        // Read before b ends, asserted after the record so a missing record is the first failure.
        const anchorTaskId = (yield* thread(s.child)).ownership?.anchorTaskId;
        const anchorBefore = (yield* orchestrator.getThreadProjection(owner)).subagents.find(
          (task) => task.id === anchorTaskId,
        );
        const bBefore = (yield* orchestrator.getThreadProjection(s.child)).runs.find(
          (run) => run.id === b.id,
        )!;
        if (variant !== "finished") {
          yield* replyOnChild(s.child, "Result of b.");
          const bRecorded = yield* awaitResultText(owner, s.child, "Result of b.");
          yield* endChildRun(s.child);
          yield* bRecorded;
        }
        // [F] recorded(current owner, b), class E, with b's own text.
        const recorded = yield* recordedTask(owner, s.child, b.id);
        assert.isDefined(recorded, "recorded(owner, b)");
        assert.equal(recorded?.result, "Result of b.", "the owner records b's text");
        assert.isTrue(notifiable(recorded), "b's delivery is eligible");
        yield* requireTakeover;
        assert.isTrue(outcome.ok);
        assert.equal(recorded?.resultRunId, b.id);
        assert.equal(recorded?.id, anchorTaskId);
        if (variant !== "finished") {
          // [N] the commit opened the owner's anchor for b and bound b to it.
          assert.isDefined(anchorBefore);
          assert.isNull(anchorBefore?.result);
          assert.equal(bBefore.delegatedTaskId, anchorTaskId);
        }
        // [N] a's record and receipt on P are unchanged.
        const after = yield* predecessorTask(s.predecessor, s.child);
        assert.equal(after.result, "Result of a.");
        assert.deepEqual(after.completionDelivery, receipt.completionDelivery);
        // Recovery twice: the second pass writes nothing, and b stays recorded.
        yield* outbox.reconcileAfterProcessLoss;
        yield* orchestrator.recoverDelegatedTasks;
        const afterFirst = yield* sink.latestSequence();
        yield* outbox.reconcileAfterProcessLoss;
        yield* orchestrator.recoverDelegatedTasks;
        assert.equal(yield* sink.latestSequence(), afterFirst);
        assert.deepEqual(yield* recordedTask(owner, s.child, b.id), recorded);
      }),
  );
});

/**
 * P2-1 (plan §6, §9 "fresh service instances"): each server process is a fresh build of the
 * layers over one database file. Closing a process closes its reactors, reconciler, locks, stores
 * and connection, so the next one starts only from what is on disk.
 */
const layerForwardFile = (dbPath: string) =>
  makeLayerTest(SqlitePersistence.layerFromPath(dbPath)).pipe(Layer.provideMerge(layerProbe));
type ProcessServices = Layer.Success<ReturnType<typeof layerForwardFile>>;

/** A temporary database file, removed with the test's scope. */
const databaseFile = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-takeover-restart-" });
  return path.join(directory, "state.sqlite");
}).pipe(Effect.provide(NodeServices.layer));

/** Runs `body` as one server process over `dbPath`, then shuts that process down completely. */
const processOver =
  (dbPath: string) =>
  <A, E>(body: Effect.Effect<A, E, ProcessServices>) =>
    body.pipe(Effect.provide(Layer.fresh(layerForwardFile(dbPath))));

/**
 * Startup after a process loss in production order (`serverRuntimeStartup.ts`): provider runtime
 * recovery (with the outbox process-loss pass), delegated-task recovery with the subagent-results
 * index answering nothing, then the effect worker.
 */
const startupAfterProcessLoss = Effect.gen(function* () {
  const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* recovery.recover;
  yield* withoutResultIndex(orchestrator.recoverDelegatedTasks);
  yield* runEffects;
});

/** What a restart could add for C: result events, result transfers and forward receipts. */
const restartFootprint = (child: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly kind: string; readonly count: number }>`
      SELECT 'events' AS kind, COUNT(*) AS count FROM orchestration_v2_events
      WHERE event_type IN ('subagent.updated', 'context-transfer.created')
        AND (json_extract(payload_json, '$.childThreadId') = ${child}
          OR json_extract(payload_json, '$.sourceThreadId') = ${child})
      UNION ALL
      SELECT 'receipts' AS kind, COUNT(*) AS count FROM orchestration_command_receipts
      WHERE command_id LIKE 'takeover.forward:%'`;
    return Object.fromEntries(rows.map((row) => [row.kind, row.count]));
  });

/** Fails fast, in a process of its own, on a build without takeover. */
const requireTakeoverIn = (inProcess: ReturnType<typeof processOver>) => inProcess(requireTakeover);

/** A third fresh process: startup again adds no result event or receipt for C. */
const thirdProcessAddsNothing = (
  inProcess: ReturnType<typeof processOver>,
  holder: ThreadId,
  child: ThreadId,
  runId: RunId,
) =>
  inProcess(
    Effect.gen(function* () {
      const before = yield* restartFootprint(child);
      const recordedBefore = yield* recordedTask(holder, child, runId);
      yield* startupAfterProcessLoss;
      assert.deepEqual(yield* restartFootprint(child), before, "no new result event or receipt");
      assert.deepEqual(yield* recordedTask(holder, child, runId), recordedBefore);
    }),
  );

const forwardAtCrash = [
  "pending",
  "running",
  "failed",
  "failed, inline repair fails once",
] as const;

it.effect.each(forwardAtCrash)(
  "6/16 fresh processes: a forward %s at the crash is recorded by the next process",
  (row) =>
    Effect.gen(function* () {
      const inProcess = processOver(yield* databaseFile);
      yield* requireTakeoverIn(inProcess);
      const name = `fresh-${row.replaceAll(/[^a-z]+/g, "-")}`;
      const failing = row.startsWith("failed");
      // Process A: the takeover, a result through G and its forward row; then A dies.
      const seeded = yield* inProcess(
        Effect.gen(function* () {
          const s = yield* setup(name);
          const outbox = yield* EffectOutbox.EffectOutboxV2;
          yield* replyOnChild(s.child, "Result of a.");
          if (failing) probe.beforeForwardCommit = () => Effect.fail("injected fault");
          const runId = yield* staleRouteResult(s);
          if (failing) probe.beforeForwardCommit = () => Effect.fail("injected fault");
          const taskId = (yield* predecessorTask(s.predecessor, s.child)).id;
          if (row === "running") {
            // The worker claimed it, then the process died.
            yield* parkOtherEffects;
            yield* outbox.claimNext({ workerId: "worker:lost" });
          }
          if (failing) yield* runEffects;
          resetProbe();
          const rows = yield* forwardRows(taskId, runId);
          assert.equal(rows.current?.status, failing ? "failed" : row);
          assert.lengthOf(yield* openObligations(s.child), 1);
          return { s, runId, taskId, rearms: rows.rearms };
        }),
      );
      const { s, runId, taskId } = seeded;
      // Process B: fresh layers over the same file.
      yield* inProcess(
        Effect.gen(function* () {
          let failures = row === "failed, inline repair fails once" ? 1 : 0;
          probe.beforeForwardCommit = () =>
            failures-- > 0 ? Effect.fail("transient fault") : Effect.void;
          yield* startupAfterProcessLoss;
          resetProbe();
          // [F] recorded(S, exact a) with a's text, and the obligation is closed.
          const recorded = yield* recordedTask(s.successor, s.child, runId);
          assert.isTrue(notifiable(recorded), "recorded(S) E after a fresh process");
          assert.equal(recorded?.resultRunId, runId);
          assert.equal(recorded?.result, "Result of a.");
          assert.deepEqual(yield* openObligations(s.child), []);
          const rows = yield* forwardRows(taskId, runId);
          if (row === "failed, inline repair fails once") {
            // [N] the failed inline repair re-armed the row; this process's worker completed it.
            assert.equal(rows.rearms, seeded.rearms + 1);
            assert.equal(rows.current?.status, "succeeded");
          }
          // One success receipt at most, whichever path recorded it.
          assert.isAtMost(
            rows.receipts.filter((receipt) => receipt.status !== "rejected").length,
            1,
          );
        }).pipe(Effect.ensuring(Effect.sync(resetProbe))),
      );
      // Process C: nothing new.
      yield* thirdProcessAddsNothing(inProcess, s.successor, s.child, runId);
    }).pipe(Effect.scoped, Effect.ensuring(Effect.sync(resetProbe))),
);

it.effect(
  "6 fresh processes: a child running at the crash reports to S from the next process",
  () =>
    Effect.gen(function* () {
      const inProcess = processOver(yield* databaseFile);
      yield* requireTakeoverIn(inProcess);
      // Process A: C is running when S takes over; then A dies.
      const s = yield* inProcess(
        Effect.gen(function* () {
          const s = yield* setup("fresh-live");
          const outcome = yield* takeover(s.predecessor, s.successor);
          assert.isTrue(outcome.ok, JSON.stringify(outcome));
          return s;
        }),
      );
      // Process B: startup, then C's run finishes.
      const runId = yield* inProcess(
        Effect.gen(function* () {
          yield* startupAfterProcessLoss;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const run = (yield* orchestrator.getThreadProjection(s.child)).runs.toSorted(
            (a, b) => b.ordinal - a.ordinal,
          )[0]!;
          const anchorTaskId = (yield* thread(s.child)).ownership?.anchorTaskId;
          // The anchor binding is durable: the reopened store still names S's anchor.
          assert.equal(run.delegatedTaskId, anchorTaskId);
          yield* replyOnChild(s.child, "Result after the restart.");
          const recordedLive = yield* awaitResultText(
            s.successor,
            s.child,
            "Result after the restart.",
          );
          const runId = yield* endChildRun(s.child);
          yield* recordedLive;
          // [F] recorded(S, exact run), class E.
          const recorded = yield* recordedTask(s.successor, s.child, runId);
          assert.isTrue(notifiable(recorded), "recorded(S) E");
          assert.equal(recorded?.resultRunId, runId);
          assert.equal(recorded?.result, "Result after the restart.");
          // [N] the predecessor owes nothing: no forward obligation.
          assert.deepEqual(yield* openObligations(s.child), []);
          return runId;
        }),
      );
      yield* thirdProcessAddsNothing(inProcess, s.successor, s.child, runId);
    }).pipe(Effect.scoped),
);

it.effect("6 fresh processes: an attempt that crashed before its commit expires; P keeps C", () =>
  Effect.gen(function* () {
    const inProcess = processOver(yield* databaseFile);
    yield* requireTakeoverIn(inProcess);
    const { takeoverTransferId } = yield* Effect.promise(() => import("./ThreadTakeover.ts"));
    // Process A: begin, then the process dies before the commit.
    const s = yield* inProcess(
      Effect.gen(function* () {
        const s = yield* setup("fresh-inert");
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const now = yield* DateTime.now;
        yield* orchestrator.dispatch({
          type: "thread.takeover.begin",
          commandId: CommandId.make("fresh-inert-begin"),
          threadId: s.predecessor,
          successorThreadId: s.successor,
          transferId: takeoverTransferId(
            s.predecessor,
            s.successor,
            CommandId.make(`launch:${s.successor}`),
          ),
          attempt: 1,
          deadlineAt: DateTime.add(now, { seconds: 30 }),
        } as never);
        assert.equal((yield* thread(s.predecessor)).continuedBy?.state, "attempting");
        return s;
      }),
    );
    // Process B: startup; the deadline passes; C's result reaches P.
    const runId = yield* inProcess(
      Effect.gen(function* () {
        yield* startupAfterProcessLoss;
        yield* TestClock.adjust("31 seconds");
        assert.isUndefined((yield* thread(s.child)).ownership, "P still owns C");
        yield* replyOnChild(s.child, "Result for P.");
        const recordedLive = yield* awaitResultText(s.predecessor, s.child, "Result for P.");
        const runId = yield* endChildRun(s.child);
        yield* recordedLive;
        // [G] P's delivery is intact.
        const recorded = yield* recordedTask(s.predecessor, s.child, runId);
        assert.isTrue(notifiable(recorded), "recorded(P) E");
        assert.equal(recorded?.result, "Result for P.");
        // [N] the inert record stayed an expired attempt: no ownership, no move on P.
        const record = (yield* thread(s.predecessor)).continuedBy;
        assert.equal(record?.state, "attempting");
        assert.isTrue(DateTime.isLessThan(record!.deadlineAt, yield* DateTime.now));
        assert.isUndefined(recorded?.transferredTo);
        assert.isUndefined(
          (yield* Orchestrator.OrchestratorV2.pipe(
            Effect.flatMap((orchestrator) => orchestrator.getThreadProjection(s.successor)),
          )).subagents.find((task) => task.childThreadId === s.child),
          "S has no anchor",
        );
        return runId;
      }),
    );
    yield* thirdProcessAddsNothing(inProcess, s.predecessor, s.child, runId);
  }).pipe(Effect.scoped),
);

/**
 * WP4 display (plan §7, §9 tests 10 and 14), against the real shell builders. "Shown under" is
 * plan §7's `displayParentThreadId` written out, so this file still loads on cc15112571.
 */
const shownUnder = (shell: {
  readonly lineage: Thread["lineage"];
  readonly ownerThreadId?: ThreadId | undefined;
}) => shell.ownerThreadId ?? shell.lineage.parentThreadId;

/** The Home push decision for a shell, with the inputs WebPushNotifications.publishThread passes. */
const pushEventFor = (shell: OrchestrationV2ThreadShell) =>
  classifyHomeNotification({
    threadId: shell.id,
    runId: shell.latestRunId,
    isChild: shell.lineage.relationshipToParent === "subagent",
    sideChat: shell.lineage.sideChat === true,
    snoozed: false,
    settled: shell.settledOverride === "settled",
    needsYou: shell.homeNeedsYou === true,
    askText: shell.homeAskText?.trim() || null,
    turnCompleted: shell.status === "completed" && shell.activityRunStatus == null,
    hasRunningChildren: (shell.pendingBackgroundTasks?.length ?? 0) > 0,
    waiting:
      shell.homeFirstNextStep?.startsWith("T3: WAIT on ") === true ||
      shell.blockedOnThreadWait === true,
    hasAutoWait: false,
    handedOff: shell.homeHandedOff === true,
    doneText: shell.homeDoneText ?? null,
  });

/** Ends a thread's latest run, or seeds and ends a new one (a wake turn), as the provider would. */
const endTurn = (threadId: ThreadId, options: { readonly newRun?: string } = {}) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const latest = (yield* orchestrator.getThreadProjection(threadId)).runs.toSorted(
      (a, b) => b.ordinal - a.ordinal,
    )[0]!;
    const run =
      options.newRun === undefined
        ? latest
        : {
            ...latest,
            id: RunId.make(options.newRun),
            ordinal: latest.ordinal + 1,
            userMessageId: MessageId.make(`${options.newRun}:message`),
            requestedAt: now,
            startedAt: now,
          };
    yield* sink.write({
      events: [
        {
          id: EventId.make(`end-turn:${run.id}`),
          type: "run.updated",
          threadId,
          runId: run.id,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: { ...run, status: "completed", completedAt: now },
        },
      ],
    });
    return run.id;
  });

/**
 * A provider session for C whose open waits for `release` (after signalling `entered`), then fails
 * or opens. An opened session starts turns and reports them running; `finish` ends the last one.
 */
const makeHeldSession = (outcome: "fail" | "open") =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
    const started: Array<ProviderAdapter.ProviderAdapterV2TurnInput> = [];
    const providerTurn = (turn: ProviderAdapter.ProviderAdapterV2TurnInput, now: DateTime.Utc) => ({
      id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
      providerThreadId: turn.providerThread.id,
      nodeId: turn.rootNodeId,
      runAttemptId: turn.attemptId,
      nativeTurnRef: {
        driver,
        nativeId: `native-turn:${turn.attemptId}`,
        strength: "strong" as const,
      },
      ordinal: turn.providerTurnOrdinal,
      status: "running" as const,
      startedAt: now,
      completedAt: null,
    });
    const open: ProviderAdapter.ProviderAdapterV2["Service"]["openSession"] = (input) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
        if (outcome === "fail") {
          return yield* new ProviderAdapter.ProviderAdapterOpenSessionError({
            driver,
            providerSessionId: input.providerSessionId,
            cause: new Error("held session failed to open"),
          });
        }
        const now = yield* DateTime.now;
        return {
          instanceId: modelSelection.instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: modelSelection.instanceId,
            status: "ready",
            cwd: "/workspace/held-session",
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: ({
            threadId,
            existingProviderThread,
          }: ProviderAdapter.ProviderAdapterV2EnsureThreadInput) =>
            Effect.succeed({
              ...existingProviderThread!,
              appThreadId: threadId,
              providerSessionId: input.providerSessionId,
              nativeThreadRef: existingProviderThread?.nativeThreadRef ?? {
                driver,
                nativeId: `native:${threadId}`,
                strength: "strong",
              },
              updatedAt: now,
            }),
          resumeThread: ({
            providerThread,
          }: {
            readonly providerThread: OrchestrationV2ProviderThread;
          }) => Effect.succeed(providerThread),
          startTurn: (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
            Effect.gen(function* () {
              started.push(turn);
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: providerTurn(turn, yield* DateTime.now),
              });
            }),
          steerTurn: () => Effect.die("unused"),
          interruptTurn: () => Effect.die("unused"),
          respondToRuntimeRequest: () => Effect.die("unused"),
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        } as never;
      });
    /** Ends the last started turn as the provider reports a completed turn. */
    const finish = Effect.gen(function* () {
      const turn = started.at(-1);
      if (turn === undefined) return yield* Effect.die("no turn was started");
      const now = yield* DateTime.now;
      const completed = {
        ...providerTurn(turn, now),
        status: "completed" as const,
        completedAt: now,
      };
      yield* Queue.offer(events, {
        type: "provider_turn.updated",
        driver,
        providerTurn: completed,
      });
      yield* Queue.offer(events, {
        type: "turn.terminal",
        driver,
        providerThreadId: completed.providerThreadId,
        providerTurnId: completed.id,
        runOrdinal: turn.runOrdinal,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      } as ProviderAdapter.ProviderAdapterV2Event);
    });
    return { entered, release, open, finish, started };
  });

/** The ids of the family read for `member`, as `getThreadFamily` serves it. */
const familyIds = (member: ThreadId) =>
  Effect.flatMap(ProjectionStore.ProjectionStoreV2, (store) =>
    store.getShellSnapshot({ location: "active", familyOf: member }),
  ).pipe(Effect.map((snapshot) => snapshot.threads.map((shell) => shell.id)));

/** C's own subagent G, created before any move. */
const delegateGrandchild = (child: ThreadId, name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const childRun = (yield* orchestrator.getThreadProjection(child)).runs[0]!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      createdBy: "agent",
      creationSource: "mcp",
      commandId: CommandId.make(`${name}-grandchild`),
      parentThreadId: child,
      parentRunId: childRun.id,
      parentNodeId: childRun.rootNodeId!,
      task: "Look deeper.",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
    });
    return (yield* orchestrator.getThreadProjection(child)).subagents.find(
      (task) => task.childThreadId !== null,
    )!.childThreadId!;
  });

it.layer(layerTest)("thread takeover display (WP4)", (it) => {
  it.effect("10: the moved child shows under the successor, which waits on it; P does not", () =>
    Effect.gen(function* () {
      const { predecessor, successor, child } = yield* setup("t10");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      // C's own subagent G, created before the move: it follows C under S.
      const childRun = (yield* orchestrator.getThreadProjection(child)).runs[0]!;
      yield* orchestrator.dispatch({
        type: "delegated_task.request",
        createdBy: "agent",
        creationSource: "mcp",
        commandId: CommandId.make("t10-grandchild"),
        parentThreadId: child,
        parentRunId: childRun.id,
        parentNodeId: childRun.rootNodeId!,
        task: "Look deeper.",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        completionWake: "always",
      });
      const grandchild = (yield* orchestrator.getThreadProjection(child)).subagents.find(
        (task) => task.childThreadId !== null,
      )!.childThreadId!;

      yield* takeover(predecessor, successor);
      // [G] while S's own turn runs it is working, as any parent with a running child is (.23).
      assert.equal((yield* orchestrator.getThreadShell(successor))?.waitPhase, "working");

      yield* endTurn(successor);
      const sqlShells = (yield* store.getShellSnapshot({ location: "active" })).threads;
      const sqlShell = (id: ThreadId) => sqlShells.find((shell) => shell.id === id)!;
      for (const read of ["in-memory", "sql"] as const) {
        const shellOf = (id: ThreadId) =>
          read === "sql"
            ? Effect.succeed(sqlShell(id))
            : Effect.map(orchestrator.getThreadShell(id), (shell) => shell!);
        // [F] C is S's direct subagent in the shell rows both builders send; G stays under C.
        assert.equal(shownUnder(yield* shellOf(child)), successor, `${read}: C under S`);
        assert.equal(shownUnder(yield* shellOf(grandchild)), child, `${read}: G under C`);
        // [F] S waits on its subagent C once its turn ended; [G] P does not show C.
        const successorShell = yield* shellOf(successor);
        assert.isTrue(
          (successorShell.waitingOn ?? []).some(
            (target) => target.threadId === child && target.source === "awaited_child",
          ),
          `${read}: S waits on C`,
        );
        assert.equal(successorShell.waitPhase, "waiting", `${read}: S's phase`);
        assert.isFalse(
          ((yield* shellOf(predecessor)).waitingOn ?? []).some(
            (target) => target.threadId === child,
          ),
          `${read}: P does not wait on C`,
        );
      }
      // [N] the former owners the client normalises senders over.
      assert.deepEqual(sqlShell(child).formerOwnerThreadIds, [predecessor]);
      // [F] a trimmed subscriber snapshot keeps C and its owner S, with C shown under S.
      const trimmed = activeShellRowsForSubscriber(sqlShells, true).threads;
      assert.isTrue(trimmed.some((shell) => shell.id === successor));
      assert.equal(shownUnder(trimmed.find((shell) => shell.id === child)!), successor);

      // [F] families group by display root: a read from S, C or G is S's family, without P;
      // P's family no longer holds C or G.
      for (const member of [successor, child, grandchild]) {
        assert.sameMembers(
          yield* familyIds(member),
          [successor, child, grandchild],
          `familyOf ${member}`,
        );
      }
      assert.sameMembers(yield* familyIds(predecessor), [predecessor], "familyOf P");
    }),
  );

  it.effect("10: after P->S->T a moved child's family is T's, without P or S", () =>
    Effect.gen(function* () {
      const s = yield* setup("t10-chain");
      const grandchild = yield* delegateGrandchild(s.child, "t10-chain");
      const t = yield* seedSuccessorOf(s, "t10-chain");
      yield* takeover(s.predecessor, s.successor);
      yield* takeover(s.successor, t);
      for (const member of [t, s.child, grandchild]) {
        assert.sameMembers(
          yield* familyIds(member),
          [t, s.child, grandchild],
          `familyOf ${member}`,
        );
      }
      assert.sameMembers(yield* familyIds(s.predecessor), [s.predecessor], "familyOf P");
      assert.sameMembers(yield* familyIds(s.successor), [s.successor], "familyOf S");
    }),
  );

  it.effect("10: opening C directly with S trimmed from the shell restores S from C's family", () =>
    Effect.gen(function* () {
      const s = yield* setup("t10-open");
      const grandchild = yield* delegateGrandchild(s.child, "t10-open");
      const store = yield* ProjectionStore.ProjectionStoreV2;
      yield* takeover(s.predecessor, s.successor);
      // The trimmed shell this client holds: S is an older settled owner and C an idle subagent,
      // both left to the family read.
      const shell = (yield* store.getShellSnapshot({ location: "active" })).threads.filter(
        (row) => row.id !== s.successor && row.id !== s.child,
      );
      const present = new Set(shell.map((row) => row.id));
      // What threadFamilyRowsMissingFromShell merges in when the route mounts C's family.
      const family = (yield* store.getShellSnapshot({ location: "active", familyOf: s.child }))
        .threads;
      const rows = [...shell, ...family.filter((row) => !present.has(row.id))];
      const row = (id: ThreadId) => rows.find((candidate) => candidate.id === id);
      // [F] C's display parent S, and G's parent C, are both rows the client can now walk to.
      assert.equal(shownUnder(row(s.child)!), s.successor);
      assert.isDefined(row(s.successor), "S is restored");
      assert.equal(shownUnder(row(grandchild)!), s.child);
      assert.isFalse(
        family.some((candidate) => candidate.id === s.predecessor),
        "P is not in C's family",
      );
    }),
  );

  it.effect("14: provider-native and command work stay on the predecessor", () =>
    Effect.gen(function* () {
      const { predecessor, successor, predecessorRunId } = yield* setup("t14-native");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const nodeId = NodeId.make(`root:${predecessor}`);
      const base = {
        threadId: predecessor,
        runId: predecessorRunId,
        nodeId,
        providerThreadId: ProviderThreadId.make(`provider:${predecessor}`),
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        status: "running",
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      } as const;
      const commandItem = TurnItemId.make("t14-native:command");
      const nativeItem = TurnItemId.make("t14-native:subagent");
      const nativeTask = NodeId.make("t14-native:task");
      yield* sink.write({
        events: [
          {
            id: EventId.make("t14-native:command-item"),
            type: "turn-item.updated",
            threadId: predecessor,
            runId: predecessorRunId,
            occurredAt: now,
            payload: {
              ...base,
              id: commandItem,
              ordinal: 900,
              type: "command_execution",
              input: "vp run dev",
            },
          },
          {
            id: EventId.make("t14-native:subagent-item"),
            type: "turn-item.updated",
            threadId: predecessor,
            runId: predecessorRunId,
            occurredAt: now,
            payload: {
              ...base,
              id: nativeItem,
              ordinal: 901,
              type: "subagent",
              subagentId: nativeTask,
              origin: "provider_native",
              driver,
              providerInstanceId: modelSelection.instanceId,
              childThreadId: null,
              prompt: "Native review",
              result: null,
            },
          },
          {
            id: EventId.make("t14-native:subagent-row"),
            type: "subagent.updated",
            threadId: predecessor,
            runId: predecessorRunId,
            occurredAt: now,
            payload: {
              ...base,
              id: nativeTask,
              ordinal: 901,
              parentNodeId: nodeId,
              origin: "provider_native",
              createdBy: "agent",
              driver,
              providerInstanceId: modelSelection.instanceId,
              providerThreadId: null,
              childThreadId: null,
              nativeTaskRef: null,
              prompt: "Native review",
              model: null,
              result: null,
            },
          },
        ] as never,
      });
      yield* takeover(predecessor, successor);
      // [G] both stay on P, still running, and nothing of them appears on S.
      const p = yield* orchestrator.getThreadProjection(predecessor);
      const itemStatus = (id: TurnItemId) => p.turnItems.find((item) => item.id === id)?.status;
      assert.equal(itemStatus(commandItem), "running");
      assert.equal(itemStatus(nativeItem), "running");
      const native = p.subagents.find((task) => task.id === nativeTask);
      assert.equal(native?.status, "running");
      assert.isUndefined(native?.transferredTo);
      const s = yield* orchestrator.getThreadProjection(successor);
      assert.isFalse(s.turnItems.some((item) => item.id === commandItem || item.id === nativeItem));
      assert.isFalse(s.subagents.some((task) => task.origin === "provider_native"));
    }),
  );

  it.effect(
    "14: a pull request watch stays on the predecessor through takeover and continuation",
    () =>
      Effect.gen(function* () {
        const { predecessor, successor, child } = yield* setup("t14-pr");
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const pullRequest = { host: "github.com", repository: "pingdotgg/t3code", number: 14 };
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make("t14-pr:watch"),
          threadId: predecessor,
          ...pullRequest,
          watching: true,
          link: { url: "https://github.com/pingdotgg/t3code/pull/14", source: "agent" },
        });
        const watched = (threadId: ThreadId) =>
          Effect.map(orchestrator.getThreadProjection(threadId), (projection) =>
            (projection.thread.pullRequests ?? [])
              .filter((link) => link.watch !== undefined)
              .map((link) => link.number),
          );
        const watchTask = (threadId: ThreadId) =>
          Effect.map(orchestrator.getThreadShell(threadId), (shell) =>
            (shell?.pendingBackgroundTasks ?? []).some(
              (task) => task.taskId === pullRequestWatchTaskId({ ...pullRequest }),
            ),
          );
        assert.deepEqual(yield* watched(predecessor), [14]);

        yield* takeover(predecessor, successor);
        // [G] the watch stays on P (excluded from the moved work), and none appears on S.
        assert.deepEqual(yield* watched(predecessor), [14], "P keeps the watch");
        assert.deepEqual(yield* watched(successor), [], "S has no watch");

        // [G] continuation: S's turn ends and C finishes into S, then P's turn ends. P's roster
        // (listed once its turn ended, as in .23) still holds the watch; S's never does.
        yield* endTurn(successor);
        yield* finishChild(child);
        yield* endTurn(predecessor);
        assert.deepEqual(yield* watched(predecessor), [14], "P keeps the watch after continuation");
        assert.isTrue(yield* watchTask(predecessor), "P lists its watch");
        assert.deepEqual(yield* watched(successor), []);
        assert.isFalse(yield* watchTask(successor), "S lists no watch");
      }),
  );

  it.effect("14: the successor is pushed for the migrated completion, not before it", () =>
    Effect.gen(function* () {
      const { predecessor, successor, child } = yield* setup("t14-push");
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const shellOf = (id: ThreadId) =>
        Effect.map(
          store.getShellSnapshot({ location: "active", threadIds: [id] }),
          (snapshot) => snapshot.threads[0]!,
        );
      yield* takeover(predecessor, successor);
      yield* endTurn(successor);
      // [F] no early "done" push for S while its subagent runs (S's turn ended, C still works).
      assert.isNull(pushEventFor(yield* shellOf(successor)), "no push while C runs");
      const runId = yield* finishChild(child);
      // [F] recorded(S, a), class E: S is woken by the migrated completion.
      assert.isTrue(notifiable(yield* recordedTask(successor, child, runId)), "S is notified");
      // [G] the wake turn that takes C's result ends with S's usual done push and identity.
      const wakeRun = yield* endTurn(successor, { newRun: "t14-s-wake" });
      assert.deepInclude(pushEventFor(yield* shellOf(successor)) ?? {}, {
        kind: "done",
        key: `done:${successor}:${wakeRun}`,
      });
    }),
  );

  // The run executor ends C's run from its turn-start snapshot, which predates the takeover's
  // rebind of that run to S's anchor.
  it.effect.each(["alone", "with a grandchild"] as const)(
    "1b: a child running at takeover that ends from its turn-start snapshot reports to S (%s)",
    (variant) =>
      Effect.gen(function* () {
        const name = variant === "alone" ? "t1b" : "t1b-g";
        const { predecessor, successor, child } = yield* setup(name);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const grandchild = variant === "alone" ? undefined : yield* delegateGrandchild(child, name);
        const snapshot = (yield* orchestrator.getThreadProjection(child)).runs[0]!;
        assert.isUndefined(snapshot.delegatedTaskId, "C's first run is unbound before the move");
        yield* takeover(predecessor, successor);
        yield* endTurn(successor);
        const anchorTaskId = (yield* thread(child)).ownership?.anchorTaskId;
        assert.isDefined(anchorTaskId);
        if (grandchild !== undefined) {
          // G finishes after the move and C's live turn takes its result.
          yield* finishChild(grandchild);
          const grandchildTask = (yield* orchestrator.getThreadProjection(child)).subagents.find(
            (task) => task.childThreadId === grandchild,
          )!;
          yield* orchestrator.dispatch({
            type: "delegated_task.completion-delivery.acknowledge",
            commandId: CommandId.make(`${name}-ack-grandchild`),
            parentThreadId: child,
            taskId: grandchildTask.id,
            observedByRunId: snapshot.id,
          });
        }
        yield* replyOnChild(child, "Result after the move.");
        const recordedOnS = yield* awaitResultText(successor, child, "Result after the move.");
        const runId = yield* endChildRun(child, "completed", snapshot);
        yield* recordedOnS;

        // [F] the run keeps the anchor binding the stale terminal write did not carry.
        const childRun = (yield* orchestrator.getThreadProjection(child)).runs.find(
          (run) => run.id === runId,
        )!;
        assert.equal(childRun.status, "completed");
        assert.equal(childRun.delegatedTaskId, anchorTaskId, "C's run stays bound to S's anchor");
        // [F] S's anchor completes with C's result and is offered to S as a wake.
        const s = yield* orchestrator.getThreadProjection(successor);
        const anchor = s.subagents.find((task) => task.id === anchorTaskId);
        assert.equal(anchor?.status, "completed");
        assert.equal(anchor?.result, "Result after the move.");
        assert.equal(anchor?.resultRunId, runId);
        assert.isTrue(notifiable(anchor), "S is offered C's result");
        assert.isTrue(
          s.contextTransfers.some(
            (transfer) =>
              transfer.type === "subagent_result" &&
              transfer.sourceThreadId === child &&
              transfer.targetThreadId === successor,
          ),
          "C's result transfers to S",
        );
        // [F] S no longer waits on C, nor lists it as running work, in either shell builder.
        const sqlShell = (yield* store.getShellSnapshot({ location: "active" })).threads.find(
          (row) => row.id === successor,
        )!;
        const liveShell = (yield* orchestrator.getThreadShell(successor))!;
        for (const [read, shell] of [
          ["in-memory", liveShell],
          ["sql", sqlShell],
        ] as const) {
          assert.isFalse(
            (shell.waitingOn ?? []).some((target) => target.threadId === child),
            `${read}: S does not wait on C`,
          );
          assert.isFalse(
            (shell.pendingBackgroundTasks ?? []).some((task) => task.taskId === anchorTaskId),
            `${read}: S lists no running anchor`,
          );
          assert.notEqual(shell.waitPhase, "waiting", `${read}: S's phase`);
        }
        // [N] P's original task stays closed by the move.
        const old = (yield* orchestrator.getThreadProjection(predecessor)).subagents.find(
          (task) => task.childThreadId === child,
        )!;
        assert.equal(old.transferredTo?.threadId, successor);
        assert.equal(old.completionDelivery?.state, "disposed");
      }),
  );

  // P's follow-up run on C is still starting (its provider session opening) when the takeover
  // rebinds it to S's anchor. The real turn start and run executor then write it from the run they
  // read before the move, which carries P's follow-up task id.
  it.effect.each(["fails to open", "opens and completes"] as const)(
    "1c: a follow-up starting at takeover ends through the real turn start and reports to S (session %s)",
    (variant) =>
      Effect.gen(function* () {
        const name = variant === "fails to open" ? "t1c-fail" : "t1c-run";
        const { predecessor, successor, child } = yield* setup(name);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
        yield* replyOnChild(child, "First result.");
        yield* finishChild(child);
        const messageId = MessageId.make(`${name}-follow-up`);
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${name}-follow-up`),
          threadId: child,
          messageId,
          text: "One more check, please.",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          // A person's send for the owner P; it needs no agent selection provenance to start.
          createdBy: "user",
          creationSource: "web",
        } as never);
        const runOf = Effect.map(orchestrator.getThreadProjection(child), (projection) =>
          projection.runs.find((run) => run.userMessageId === messageId),
        );
        const followUp = (yield* runOf)!;
        assert.equal(followUp.status, "starting");
        assert.isDefined(followUp.delegatedTaskId, "P's follow-up is bound to its task");
        yield* parkOtherEffects.pipe(
          Effect.provideService(FixtureThreads, [predecessor, successor, child]),
        );

        const session = yield* makeHeldSession(variant === "fails to open" ? "fail" : "open");
        const start = yield* executor
          .execute(
            {
              id: `effect:${name}:provider-turn.start`,
              threadId: child,
              request: { type: "provider-turn.start", runId: followUp.id },
            } as never,
            { willRetry: false },
          )
          .pipe(
            Effect.provideService(TestSession, session.open),
            Effect.forkChild({ startImmediately: true }),
          );
        assert.isTrue(
          Option.isSome(
            yield* TestClock.withLive(
              Deferred.await(session.entered).pipe(Effect.timeoutOption("5 seconds")),
            ),
          ),
          "C's turn start reaches its provider session",
        );
        yield* takeover(predecessor, successor);
        yield* endTurn(successor);
        const anchorTaskId = (yield* thread(child)).ownership?.anchorTaskId;
        assert.isDefined(anchorTaskId);
        assert.equal(
          (yield* runOf)?.delegatedTaskId,
          anchorTaskId,
          "the move rebinds the follow-up",
        );

        yield* Deferred.succeed(session.release, undefined);
        yield* TestClock.withLive(Fiber.join(start).pipe(Effect.timeout("10 seconds")));
        if (variant === "opens and completes") {
          assert.equal((yield* runOf)?.status, "running");
          yield* replyOnChild(child, "Result after the move.");
          const runEnded = yield* awaitStoredEvent(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === followUp.id &&
              event.payload.status === "completed",
          );
          yield* session.finish;
          assert.isTrue(Option.isSome(yield* runEnded), "the run executor ends C's follow-up");
          // The executor queued the run's checkpoint capture, which settles it for the finalizer.
          const sql = yield* SqlClient.SqlClient;
          const captureId = `effect:checkpoint.capture:${followUp.id}`;
          yield* sql`
            UPDATE orchestration_v2_effect_outbox SET status = 'cancelled', lease_owner = NULL
            WHERE status IN ('pending', 'running') AND effect_id != ${captureId}
              AND ${sql.in("thread_id", [predecessor, successor, child])}
          `;
          yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
          const capture = yield* sql<{ readonly status: string }>`
            SELECT status FROM orchestration_v2_effect_outbox WHERE effect_id = ${captureId}
          `;
          assert.equal(capture[0]?.status, "succeeded", "the run's checkpoint capture ran");
        }
        yield* runEffects.pipe(
          Effect.provideService(FixtureThreads, [predecessor, successor, child]),
        );

        // [F] the start's and executor's writes keep the anchor binding.
        const ended = (yield* runOf)!;
        assert.equal(ended.status, variant === "fails to open" ? "failed" : "completed");
        assert.equal(
          ended.delegatedTaskId,
          anchorTaskId,
          "C's follow-up stays bound to S's anchor",
        );
        // [F] S's anchor finalizes with that run and is offered to S.
        const s = yield* orchestrator.getThreadProjection(successor);
        const anchor = s.subagents.find((task) => task.id === anchorTaskId);
        assert.notEqual(anchor?.status, "running", "S's anchor is finalized");
        assert.equal(anchor?.resultRunId, followUp.id);
        assert.isTrue(notifiable(anchor), "S is offered C's result");
        if (variant === "opens and completes") {
          assert.equal(anchor?.result, "Result after the move.");
        }
        // [F] S no longer waits on C in either shell builder.
        const sqlShell = (yield* store.getShellSnapshot({ location: "active" })).threads.find(
          (row) => row.id === successor,
        )!;
        const liveShell = (yield* orchestrator.getThreadShell(successor))!;
        for (const [read, shell] of [
          ["in-memory", liveShell],
          ["sql", sqlShell],
        ] as const) {
          assert.isFalse(
            (shell.waitingOn ?? []).some((target) => target.threadId === child),
            `${read}: S does not wait on C`,
          );
          assert.isFalse(
            (shell.pendingBackgroundTasks ?? []).some((task) => task.taskId === anchorTaskId),
            `${read}: S lists no running anchor`,
          );
          assert.notEqual(shell.waitPhase, "waiting", `${read}: S's phase`);
        }
      }),
  );
});

/**
 * .23 upgrade/rollback over persisted state (plan §8), steps of scripts/takeover-compat-gate-23.ts;
 * copied into a cc15112571 worktree, the .23 steps use .23's own stores and startup. Fixture files
 * only, in T3_TAKEOVER_COMPAT_DIR; T3_TAKEOVER_COMPAT_STEP names the step.
 */
const compatDir = process.env.T3_TAKEOVER_COMPAT_DIR;
const compatStep = process.env.T3_TAKEOVER_COMPAT_STEP;
const compatFile = (name: string) => `${compatDir}/${name}`;

const withFileSystem = <A, E>(
  body: (fileSystem: FileSystem.FileSystem) => Effect.Effect<A, E, never>,
) => Effect.flatMap(FileSystem.FileSystem, body).pipe(Effect.provide(NodeServices.layer));
const writeJson = (name: string, value: unknown) =>
  withFileSystem((fileSystem) =>
    fileSystem.writeFileString(compatFile(name), JSON.stringify(value, null, 2)),
  );
const readJson = <A>(name: string) =>
  withFileSystem((fileSystem) => fileSystem.readFileString(compatFile(name))).pipe(
    Effect.map((text) => JSON.parse(text) as A),
  );
/** A scoped copy of a fixture database (with its WAL, if any), so a step never edits the fixture. */
const copyOfFixture = (name: string) =>
  Effect.gen(function* () {
    const target = yield* databaseFile;
    yield* withFileSystem((fileSystem) =>
      Effect.gen(function* () {
        yield* fileSystem.copyFile(compatFile(name), target);
        if (yield* fileSystem.exists(`${compatFile(name)}-wal`)) {
          yield* fileSystem.copyFile(`${compatFile(name)}-wal`, `${target}-wal`);
        }
      }),
    );
    return target;
  });

/** The task fields both builds decode, for every task of `holder` on `child`. */
const taskViews = (holder: ThreadId, child: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.getThreadProjection(holder),
  ).pipe(
    Effect.map((projection) =>
      projection.subagents
        .filter((task) => task.childThreadId === child)
        .map((task) => ({
          id: task.id,
          status: task.status,
          result: task.result,
          delivery: task.completionDelivery?.state ?? null,
        }))
        .toSorted((a, b) => a.id.localeCompare(b.id)),
    ),
  );

/** Forward outbox rows (re-armed copies included) and takeover command receipts, raw. */
const takeoverRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const forwards = yield* sql<{ readonly effect_id: string; readonly status: string }>`
    SELECT effect_id, status FROM orchestration_v2_effect_outbox
    WHERE effect_type = 'takeover.forward' ORDER BY effect_id`;
  const receipts = yield* sql<{ readonly command_id: string; readonly status: string }>`
    SELECT command_id, status FROM orchestration_command_receipts
    WHERE command_id LIKE 'takeover.%' ORDER BY command_id`;
  return {
    forwards: forwards.map((row) => ({ effectId: row.effect_id, status: row.status })),
    receipts: receipts.map((row) => ({ commandId: row.command_id, status: row.status })),
  };
});

/** Every stored event, decoded by this build's event store: the event log's replay. */
const replayEventLog = Effect.gen(function* () {
  const sink = yield* EventSink.EventSinkV2;
  const sql = yield* SqlClient.SqlClient;
  const stored = (yield* sql<{ readonly sequence: number }>`
    SELECT sequence FROM orchestration_events WHERE aggregate_kind = 'thread'
    ORDER BY sequence`).map((row) => row.sequence);
  const latest = stored.at(-1) ?? 0;
  const decoded =
    latest === 0
      ? []
      : yield* sink.stream({ afterSequence: 0 }).pipe(
          Stream.takeUntil((event) => event.sequence >= latest),
          Stream.map((event) => event.sequence),
          Stream.runCollect,
        );
  return { stored, decoded: [...decoded] };
});

/** This build's decode of every projection row: no thread may be unreadable. */
const assertEverythingDecodes = (threadIds: ReadonlyArray<ThreadId>) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    assert.deepEqual(yield* store.getUnreadableThreadIds(), [], "no unreadable thread");
    for (const threadId of threadIds) yield* orchestrator.getThreadProjection(threadId);
    const shells = (yield* store.getShellSnapshot({ location: "active" })).threads;
    for (const threadId of threadIds) {
      assert.isDefined(
        shells.find((shell) => shell.id === threadId),
        `shell row for ${threadId}`,
      );
    }
    const { stored, decoded } = yield* replayEventLog;
    assert.isNotEmpty(stored);
    assert.deepEqual(decoded, stored, "every stored event decodes, in order");
    return shells;
  });

/** The takeover rollback preflight (branch only) over a closed database file. */
const rollbackPreflight = (dbPath: string, now: DateTime.Utc) =>
  Effect.promise(async () => {
    const { takeoverRollbackBlockers } = await import("./takeoverRollbackPreflight.ts");
    const NodeSqlite = await import("node:sqlite");
    const database = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
    try {
      return takeoverRollbackBlockers(database, DateTime.formatIso(now));
    } finally {
      database.close();
    }
  });
/** Sets a fixture copy's outbox rows under `effectIdPrefix` to `status`. */
const setOutboxStatus = (dbPath: string, effectIdPrefix: string, status: string) =>
  Effect.promise(async () => {
    const NodeSqlite = await import("node:sqlite");
    const database = new NodeSqlite.DatabaseSync(dbPath);
    try {
      database
        .prepare(
          "UPDATE orchestration_v2_effect_outbox SET status = ?, lease_owner = NULL WHERE effect_id LIKE ?",
        )
        .run(status, `${effectIdPrefix}%`);
    } finally {
      database.close();
    }
  });

interface From23 {
  readonly predecessor: ThreadId;
  readonly successor: ThreadId;
  readonly child: ThreadId;
  readonly done: ThreadId;
  readonly doneTasks: ReadonlyArray<unknown>;
}
interface From24Settled {
  readonly predecessor: ThreadId;
  readonly successor: ThreadId;
  readonly child: ThreadId;
  readonly runId: RunId;
  readonly successorTasks: ReadonlyArray<unknown>;
  readonly predecessorTasks: ReadonlyArray<unknown>;
  readonly rows: Effect.Success<typeof takeoverRows>;
}

describe.runIf(compatStep === "write-23")("compat gate .23: baseline writes", () => {
  it.effect("writes .23 state: P running with a live child C, a finished child, S unproven", () =>
    Effect.gen(function* () {
      const fixture = yield* processOver(compatFile("from23.sqlite"))(
        Effect.gen(function* () {
          const s = yield* setup("c23");
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.dispatch({
            type: "delegated_task.request",
            createdBy: "agent",
            creationSource: "mcp",
            commandId: CommandId.make("c23-delegate-done"),
            parentThreadId: s.predecessor,
            parentRunId: s.predecessorRunId,
            parentNodeId: NodeId.make(`root:${s.predecessor}`),
            task: "Finish on .23.",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            completionWake: "always",
          });
          const done = (yield* orchestrator.getThreadProjection(s.predecessor)).subagents.find(
            (task) => task.childThreadId !== null && task.childThreadId !== s.child,
          )!.childThreadId!;
          yield* replyOnChild(done, "Result on .23.");
          yield* finishChild(done);
          return {
            predecessor: s.predecessor,
            successor: s.successor,
            child: s.child,
            done,
            doneTasks: yield* taskViews(s.predecessor, done),
          } satisfies From23;
        }),
      );
      assert.equal((fixture.doneTasks[0] as { readonly result: string }).result, "Result on .23.");
      yield* writeJson("from23.json", fixture);
    }),
  );
});

describe.runIf(compatStep === "on-24")("compat gate .23: branch reads .23 and writes .24", () => {
  it.effect("(a) .24 loads .23 state; a pre-.24 successor still cannot take over", () =>
    Effect.gen(function* () {
      const fixture = yield* readJson<From23>("from23.json");
      const inProcess = processOver(yield* copyOfFixture("from23.sqlite"));
      // First .24 process over the .23 file: decode everything, then try the takeover the
      // pre-.24 S cannot prove (it has no launchedBy), before startup ends S's turn.
      yield* inProcess(
        Effect.gen(function* () {
          const ids = [fixture.predecessor, fixture.successor, fixture.child, fixture.done];
          yield* assertEverythingDecodes(ids);
          assert.isUndefined((yield* thread(fixture.successor)).launchedBy, "S is pre-.24");
          assert.deepEqual(yield* taskViews(fixture.predecessor, fixture.done), fixture.doneTasks);
          const outcome = yield* takeover(fixture.predecessor, fixture.successor);
          assert.deepInclude(outcome, { ok: false, code: "takeover_unproven" });
          assert.isUndefined((yield* thread(fixture.child)).ownership, "P keeps C");
          assert.isUndefined((yield* thread(fixture.predecessor)).continuedBy);
          assert.deepEqual((yield* takeoverRows).forwards, []);
          // A successor P launches on .24 can take over the .23 predecessor's live child.
          const launched = ThreadId.make("c23-s24");
          yield* seedThread({
            threadId: launched,
            projectId: ProjectId.make("c23-project"),
            launchedBy: fixture.predecessor,
          });
          const accepted = yield* takeover(fixture.predecessor, launched);
          assert.isTrue(accepted.ok, JSON.stringify(accepted));
          assert.equal(ownerOf(yield* thread(fixture.child)), launched);
        }),
      );
      // Second .24 process: production startup over the upgraded file keeps the .23 result.
      yield* inProcess(
        Effect.gen(function* () {
          yield* startupAfterProcessLoss;
          yield* assertEverythingDecodes([fixture.predecessor, fixture.done]);
          assert.deepEqual(yield* taskViews(fixture.predecessor, fixture.done), fixture.doneTasks);
        }),
      );
    }).pipe(Effect.scoped, Effect.ensuring(Effect.sync(resetProbe))),
  );

  it.effect("(b, c) writes settled takeover state; the rollback preflight allows it", () =>
    Effect.gen(function* () {
      const file = compatFile("from24-settled.sqlite");
      const inProcess = processOver(file);
      // Process A: takeover, C's result through G, five failed forward tries; then A dies.
      const s = yield* inProcess(
        Effect.gen(function* () {
          const s = yield* setup("c24");
          yield* replyOnChild(s.child, "Result of a.");
          probe.beforeForwardCommit = () => Effect.fail("injected fault");
          const runId = yield* staleRouteResult(s);
          probe.beforeForwardCommit = () => Effect.fail("injected fault");
          yield* runEffects;
          resetProbe();
          assert.lengthOf(yield* openObligations(s.child), 1);
          return { ...s, runId };
        }),
      );
      // Process B: startup repairs once, fails once, re-arms; the worker records on S.
      const fixture = yield* inProcess(
        Effect.gen(function* () {
          let failures = 1;
          probe.beforeForwardCommit = () =>
            failures-- > 0 ? Effect.fail("transient fault") : Effect.void;
          yield* startupAfterProcessLoss;
          resetProbe();
          const recorded = yield* recordedTask(s.successor, s.child, s.runId);
          assert.equal(recorded?.result, "Result of a.");
          assert.deepEqual(yield* openObligations(s.child), []);
          const rows = yield* takeoverRows;
          // Settled forward rows of both kinds stay behind: failed re-armed copies and a success.
          assert.isTrue(
            rows.forwards.some((row) => row.status === "failed"),
            "a failed row",
          );
          assert.isTrue(
            rows.forwards.some((row) => row.status === "succeeded"),
            "a success",
          );
          assert.isNotEmpty(rows.receipts, "forward receipts");
          return {
            predecessor: s.predecessor,
            successor: s.successor,
            child: s.child,
            runId: s.runId,
            successorTasks: yield* taskViews(s.successor, s.child),
            predecessorTasks: yield* taskViews(s.predecessor, s.child),
            rows,
          } satisfies From24Settled;
        }).pipe(Effect.ensuring(Effect.sync(resetProbe))),
      );
      yield* writeJson("from24-settled.json", fixture);
      // (c) settled rows may stay: nothing live, pending or owed.
      assert.deepEqual(yield* rollbackPreflight(file, yield* DateTime.now), []);
    }).pipe(Effect.ensuring(Effect.sync(resetProbe))),
  );

  it.effect("(c) the rollback preflight rejects live, pending, owed and attempting work", () =>
    Effect.gen(function* () {
      const file = compatFile("from24-open.sqlite");
      const { takeoverTransferId } = yield* Effect.promise(() => import("./ThreadTakeover.ts"));
      const fixture = yield* processOver(file)(
        Effect.gen(function* () {
          // A migrated child still running.
          const live = yield* setup("c24o-live");
          assert.isTrue((yield* takeover(live.predecessor, live.successor)).ok);
          // A result through G whose forward row is pending and whose obligation is open.
          const owed = yield* setup("c24o-owed");
          yield* replyOnChild(owed.child, "Owed result.");
          const runId = yield* staleRouteResult(owed);
          const taskId = (yield* predecessorTask(owed.predecessor, owed.child)).id;
          assert.equal((yield* forwardRows(taskId, runId)).current?.status, "pending");
          // A takeover attempt still before its deadline.
          const attempting = yield* setup("c24o-attempt");
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const now = yield* DateTime.now;
          yield* orchestrator.dispatch({
            type: "thread.takeover.begin",
            commandId: CommandId.make("c24o-attempt-begin"),
            threadId: attempting.predecessor,
            successorThreadId: attempting.successor,
            transferId: takeoverTransferId(
              attempting.predecessor,
              attempting.successor,
              CommandId.make(`launch:${attempting.successor}`),
            ),
            attempt: 1,
            deadlineAt: DateTime.add(now, { seconds: 30 }),
          } as never);
          return { live, owed, forwardId: `effect:takeover.forward:${taskId}:${runId}` };
        }),
      ).pipe(Effect.ensuring(Effect.sync(resetProbe)));
      const now = yield* DateTime.now;
      const kinds = (blockers: ReadonlyArray<{ readonly kind: string }>) =>
        [...new Set(blockers.map((blocker) => blocker.kind))].toSorted();
      const blockers = yield* rollbackPreflight(file, now);
      assert.deepEqual(kinds(blockers), [
        "live_migrated_child",
        "open_obligation",
        "pending_forward",
        "takeover_attempting",
      ]);
      assert.isTrue(
        blockers.some(
          (blocker) =>
            blocker.kind === "live_migrated_child" && blocker.childThreadId === fixture.live.child,
        ),
        "the running migrated child",
      );
      assert.isTrue(
        blockers.some(
          (blocker) =>
            blocker.kind === "open_obligation" && blocker.childThreadId === fixture.owed.child,
        ),
        "the owed forward",
      );
      // A failed or succeeded forward row with the obligation still open still blocks.
      for (const status of ["failed", "succeeded"] as const) {
        const copy = yield* copyOfFixture("from24-open.sqlite");
        yield* setOutboxStatus(copy, fixture.forwardId, status);
        const after = yield* rollbackPreflight(copy, now);
        assert.notInclude(kinds(after), "pending_forward", status);
        assert.isTrue(
          after.some(
            (blocker) =>
              blocker.kind === "open_obligation" && blocker.childThreadId === fixture.owed.child,
          ),
          `a ${status} row with its obligation open`,
        );
      }
      // Past its deadline an attempt reads as timed out and no longer blocks.
      assert.notInclude(
        kinds(yield* rollbackPreflight(file, DateTime.add(now, { seconds: 31 }))),
        "takeover_attempting",
      );
      yield* writeJson("from24-open.json", {
        liveChild: fixture.live.child,
        owedChild: fixture.owed.child,
        blockers,
      });
    }).pipe(Effect.scoped, Effect.ensuring(Effect.sync(resetProbe))),
  );
});

describe.runIf(compatStep === "read-24")("compat gate .23: baseline reads .24 state", () => {
  it.effect("(b) .23 decodes, replays and keeps completed takeover state, twice", () =>
    Effect.gen(function* () {
      const fixture = yield* readJson<From24Settled>("from24-settled.json");
      const inProcess = processOver(yield* copyOfFixture("from24-settled.sqlite"));
      const ids = [fixture.predecessor, fixture.successor, fixture.child];
      for (const round of [1, 2]) {
        yield* inProcess(
          Effect.gen(function* () {
            yield* startupAfterProcessLoss;
            const shells = yield* assertEverythingDecodes(ids);
            // Receipts and results are preserved: S keeps C's result, P its moved task.
            assert.deepEqual(
              yield* taskViews(fixture.successor, fixture.child),
              fixture.successorTasks,
              `round ${round}: S's record`,
            );
            assert.deepEqual(
              yield* taskViews(fixture.predecessor, fixture.child),
              fixture.predecessorTasks,
              `round ${round}: P's task`,
            );
            assert.deepEqual(
              yield* takeoverRows,
              fixture.rows,
              `round ${round}: forward rows and receipts`,
            );
            // .23 knows no owner: it shows C under its lineage parent P, as plan §7 says.
            const childShell = shells.find((shell) => shell.id === fixture.child)!;
            assert.equal(childShell.lineage.parentThreadId, fixture.predecessor);
            assert.isFalse("ownerThreadId" in childShell, "the owner field is not .23's");
          }),
        );
      }
    }).pipe(Effect.scoped),
  );

  it.effect("records what .23 does with the unsettled state the preflight rejects", () =>
    Effect.gen(function* () {
      const fixture = yield* readJson<{ readonly owedChild: ThreadId }>("from24-open.json");
      const observed = yield* processOver(yield* copyOfFixture("from24-open.sqlite"))(
        Effect.gen(function* () {
          const startup = yield* Effect.exit(startupAfterProcessLoss);
          const owners = yield* Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
            orchestrator.getThreadProjection(fixture.owedChild),
          );
          return {
            startup: startup._tag,
            forwards: (yield* takeoverRows).forwards,
            owedChildParent: owners.thread.lineage.parentThreadId,
          };
        }),
      );
      // Evidence only (plan §8 "[G] baseline-replay test records the actual .23 behaviour"):
      // .23 has no forward handler and no owner, so an owed result stays unforwarded.
      yield* writeJson("observed-23-on-open.json", observed);
      assert.isTrue(
        observed.forwards.every((row) => row.status !== "succeeded"),
        ".23 never completes a forward",
      );
    }).pipe(Effect.scoped),
  );
});

/**
 * Automatic takeover: a successor launched with t3_thread_launch takes over once its run is
 * active, without calling t3_thread_takeover. Its debug lines mark each milestone.
 */
const autoLogListeners = new Set<(message: string, fields: unknown) => void>();
const autoLogger = Logger.make(({ message }) => {
  const parts = Array.isArray(message) ? message : [message];
  const first = String(parts[0]);
  if (first.startsWith("Auto takeover"))
    for (const listener of autoLogListeners) listener(first, parts[1]);
});
const layerAutoTest = makeLayerTest(SqlitePersistence.layerMemory, {
  enabled: true,
  attempts: 5,
  retrySpacingMs: 1_000,
}).pipe(
  Layer.provideMerge(Logger.layer([autoLogger], { mergeWithExisting: false })),
  Layer.provideMerge(Layer.succeed(References.MinimumLogLevel, "Debug")),
);

/** Started before an action: completes once the automatic takeover logs `line`. */
const autoLogged = (line: string) =>
  Effect.gen(function* () {
    const seen = yield* Deferred.make<void>();
    const listener = (message: string) => {
      if (message === line) Deferred.doneUnsafe(seen, Effect.void);
    };
    autoLogListeners.add(listener);
    return TestClock.withLive(Deferred.await(seen).pipe(Effect.timeoutOption("5 seconds"))).pipe(
      Effect.map(Option.isSome),
      Effect.ensuring(Effect.sync(() => autoLogListeners.delete(listener))),
    );
  });

/** Started before an action: completes once P records S's takeover as effective. */
const takeoverEffective = (predecessor: ThreadId, successor: ThreadId) =>
  awaitStoredEvent(
    (event) =>
      event.type === "thread.metadata-updated" &&
      event.threadId === predecessor &&
      (event.payload as Thread).continuedBy?.threadId === successor &&
      (event.payload as Thread).continuedBy?.state === "effective",
  );

/** P (with its app-owned child C unless told), then S (launched by P unless told) running. */
const setupAuto = (
  name: string,
  options: {
    readonly child?: boolean;
    readonly launched?: boolean;
    readonly holdPredecessor?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projectId = ProjectId.make(`${name}-project`);
    const predecessor = ThreadId.make(`${name}-p`);
    const successor = ThreadId.make(`${name}-s`);
    const parent = yield* seedThread({ threadId: predecessor, projectId, createProject: true });
    let child: ThreadId | undefined;
    if (options.child !== false) {
      yield* orchestrator.dispatch({
        type: "delegated_task.request",
        createdBy: "agent",
        creationSource: "mcp",
        commandId: CommandId.make(`${name}-delegate`),
        parentThreadId: predecessor,
        parentRunId: parent.runId,
        parentNodeId: parent.rootNodeId,
        task: "Investigate the migration.",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        completionWake: "always",
      });
      child = (yield* orchestrator.getThreadProjection(predecessor)).subagents.find(
        (candidate) => candidate.childThreadId !== null,
      )!.childThreadId!;
    }
    const release =
      options.holdPredecessor === true ? yield* holdLocks([predecessor]) : Effect.void;
    yield* seedThread({
      threadId: successor,
      projectId,
      ...(options.launched === false ? {} : { launchedBy: predecessor }),
    });
    return { predecessor, successor, child: child!, release };
  });

it.layer(layerAutoTest)("automatic takeover when a launched successor starts", (it) => {
  it.effect("moves the children once the successor's run is active; a manual call agrees", () =>
    Effect.gen(function* () {
      const effective = yield* takeoverEffective(
        ThreadId.make("auto1-p"),
        ThreadId.make("auto1-s"),
      );
      const { predecessor, successor, child } = yield* setupAuto("auto1");
      assert.isTrue(Option.isSome(yield* effective), "the takeover became effective by itself");
      assert.equal(ownerOf(yield* thread(child)), successor);
      const transferId = (yield* thread(predecessor)).continuedBy!.transferId;
      // A later manual call returns the same effective transfer and moves nothing twice.
      const manual = yield* takeover(predecessor, successor);
      assert.isTrue(manual.ok);
      if (manual.ok) {
        assert.equal(manual.result.transferId, transferId);
        assert.deepEqual(
          manual.result.migrated.map((entry) => entry.childThreadId),
          [child],
        );
      }
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const moved = (yield* orchestrator.getThreadProjection(predecessor)).subagents.filter(
        (task) => task.transferredTo !== undefined,
      );
      assert.equal(moved.length, 1);
      assert.equal((yield* thread(child)).ownership?.transferId, transferId);
    }),
  );

  it.effect("records nothing when the predecessor owns no children", () =>
    Effect.gen(function* () {
      const skipped = yield* autoLogged("Auto takeover skipped: the predecessor owns no children");
      const { predecessor } = yield* setupAuto("auto2", { child: false });
      assert.isTrue(yield* skipped);
      assert.isUndefined((yield* thread(predecessor)).continuedBy);
    }),
  );

  it.effect("leaves the children of a thread that did not launch the starting one", () =>
    Effect.gen(function* () {
      const skipped = yield* autoLogged("Auto takeover skipped: not launched by a thread");
      const { predecessor, child } = yield* setupAuto("auto3", { launched: false });
      assert.isTrue(yield* skipped);
      assert.isUndefined((yield* thread(predecessor)).continuedBy);
      assert.equal(ownerOf(yield* thread(child)), predecessor);
    }),
  );

  it.effect("retries while the predecessor stays busy, then takes over", () =>
    Effect.gen(function* () {
      const trying = yield* autoLogged("Auto takeover trying");
      const retrying = yield* autoLogged("Auto takeover retries while the predecessor is busy");
      const { predecessor, successor, child, release } = yield* setupAuto("auto4", {
        holdPredecessor: true,
      });
      assert.isTrue(yield* trying);
      // Past the try's deadline with the predecessor's lock held: it times out and waits to retry.
      yield* TestClock.adjust("31 seconds");
      assert.isTrue(yield* retrying);
      assert.isUndefined((yield* thread(predecessor)).continuedBy);
      assert.equal(ownerOf(yield* thread(child)), predecessor);
      yield* release;
      const effective = yield* takeoverEffective(predecessor, successor);
      yield* TestClock.adjust("2 seconds");
      assert.isTrue(Option.isSome(yield* effective), "the retry took over");
      assert.equal(ownerOf(yield* thread(child)), successor);
    }),
  );
});

/** Started before an action: once `successor`'s auto takeover ended, the successors still in flight. */
const autoTakeoverEnded = (successor: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const ended = yield* Deferred.make<void>();
    const listener = (message: string, fields: unknown) => {
      if (
        message === "Auto takeover ended" &&
        (fields as { readonly successorThreadId?: unknown } | undefined)?.successorThreadId ===
          successor
      )
        Deferred.doneUnsafe(ended, Effect.void);
    };
    autoLogListeners.add(listener);
    return TestClock.withLive(Deferred.await(ended).pipe(Effect.timeout("5 seconds"))).pipe(
      Effect.andThen(orchestrator.autoTakeoversInFlight),
      Effect.ensuring(Effect.sync(() => autoLogListeners.delete(listener))),
    );
  });

it.layer(layerAutoTest)("automatic takeover keeps only in-flight successors in memory", (it) => {
  it.effect("is empty after a success and after each skip", () =>
    Effect.gen(function* () {
      const succeeded = yield* autoTakeoverEnded(ThreadId.make("mem1-s"));
      const { predecessor, successor } = yield* setupAuto("mem1");
      assert.deepEqual(yield* succeeded, [], "after success");
      assert.equal((yield* thread(predecessor)).continuedBy?.threadId, successor);
      const noChildren = yield* autoTakeoverEnded(ThreadId.make("mem2-s"));
      yield* setupAuto("mem2", { child: false });
      assert.deepEqual(yield* noChildren, [], "after a skip");
      const notLaunched = yield* autoTakeoverEnded(ThreadId.make("mem3-s"));
      yield* setupAuto("mem3", { launched: false });
      assert.deepEqual(yield* notLaunched, [], "after an unlaunched thread");
    }),
  );

  it.effect("is empty after the retries are exhausted", () =>
    Effect.gen(function* () {
      const gaveUp = yield* autoLogged("Auto takeover gave up while the predecessor stayed busy");
      const ended = yield* autoTakeoverEnded(ThreadId.make("mem4-s"));
      const trying = yield* autoLogged("Auto takeover trying");
      const { predecessor, child, release } = yield* setupAuto("mem4", {
        holdPredecessor: true,
      });
      assert.isTrue(yield* trying);
      // Five tries, each past its 30 s deadline, with 1 s spacing between them.
      for (let attempt = 0; attempt < 5; attempt++) {
        yield* TestClock.adjust("31 seconds");
        yield* TestClock.adjust("1 second");
      }
      assert.isTrue(yield* gaveUp);
      assert.deepEqual(yield* ended, [], "after exhaustion");
      assert.equal(ownerOf(yield* thread(child)), predecessor);
      yield* release;
    }),
  );
});

/** Every auto-takeover server process over one database file; the probe stays the test's. */
const layerAutoFile = (dbPath: string, autoTakeover: AutoTakeover) =>
  makeLayerTest(SqlitePersistence.layerFromPath(dbPath), autoTakeover).pipe(
    Layer.provideMerge(Logger.layer([autoLogger], { mergeWithExisting: true })),
    Layer.provideMerge(Layer.succeed(References.MinimumLogLevel, "Debug")),
    Layer.provideMerge(layerProbe),
  );

it.layer(NodeServices.layer)("automatic takeover after a restart", (it) => {
  it.effect("startup recovery takes over for a successor that was already running", () =>
    Effect.gen(function* () {
      const dbPath = yield* databaseFile;
      const name = "restart-auto";
      const predecessor = ThreadId.make(`${name}-p`);
      const successor = ThreadId.make(`${name}-s`);
      // Process 1 dies before its auto takeover ran: modelled with the feature off there.
      const child = yield* setupAuto(name).pipe(
        Effect.map((setup) => setup.child),
        Effect.provide(Layer.fresh(layerAutoFile(dbPath, autoTakeoverOff))),
      );
      // Process 2: no run of S updates; only startup recovery can trigger the takeover.
      yield* Effect.gen(function* () {
        assert.isUndefined((yield* thread(predecessor)).continuedBy);
        const effective = yield* takeoverEffective(predecessor, successor);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.recoverDelegatedTasks;
        assert.isTrue(Option.isSome(yield* effective), "startup recovery took over");
        assert.equal(ownerOf(yield* thread(child)), successor);
        // A manual call afterwards agrees and moves nothing twice.
        const transferId = (yield* thread(predecessor)).continuedBy!.transferId;
        const manual = yield* takeover(predecessor, successor);
        assert.isTrue(manual.ok && manual.result.transferId === transferId);
      }).pipe(
        Effect.provide(
          Layer.fresh(layerAutoFile(dbPath, { enabled: true, attempts: 5, retrySpacingMs: 1_000 })),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("startup returns while seeding is blocked and shutdown interrupts it", () =>
    Effect.gen(function* () {
      const dbPath = yield* databaseFile;
      const interrupted = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const store = (yield* ProjectionStore.ProjectionStoreV2) as {
          -readonly [
            K in keyof ProjectionStore.ProjectionStoreV2["Service"]
          ]: ProjectionStore.ProjectionStoreV2["Service"][K];
        };
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        store.getAutoTakeoverPage = () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as([]),
            Effect.ensuring(Deferred.succeed(interrupted, undefined)),
          );
        yield* orchestrator.recoverDelegatedTasks.pipe(Effect.timeout("5 seconds"));
        yield* Deferred.await(entered);
        assert.isFalse(yield* Deferred.isDone(release));
      }).pipe(
        Effect.provide(
          Layer.fresh(layerAutoFile(dbPath, { enabled: true, attempts: 1, retrySpacingMs: 0 })),
        ),
      );
      assert.isTrue(yield* Deferred.isDone(interrupted), "scope closure interrupted seeding");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "bounded indexed pages exclude settled and archived active successors; automatic admission revalidates",
    () =>
      Effect.gen(function* () {
        const dbPath = yield* databaseFile;
        yield* Effect.gen(function* () {
          const settled = yield* setupAuto("seed-settled");
          const archived = yield* setupAuto("seed-archived");
          const live = yield* setupAuto("seed-live");
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          // Persist the historical state under review: active runs can survive a settlement/restart.
          const mark = (id: ThreadId, archived = false) =>
            Effect.gen(function* () {
              const now = yield* DateTime.now;
              yield* (yield* EventSink.EventSinkV2).write({
                events: [
                  {
                    id: EventId.make(`mark:${id}`),
                    type: "thread.metadata-updated",
                    threadId: id,
                    occurredAt: now,
                    payload: {
                      ...(yield* thread(id)),
                      ...(archived
                        ? { archivedAt: now }
                        : { settledAt: now, settledOverride: "settled" as const }),
                    },
                  },
                ],
              });
            });
          yield* mark(settled.successor);
          yield* mark(archived.successor, true);
          const store = (yield* ProjectionStore.ProjectionStoreV2) as {
            -readonly [
              K in keyof ProjectionStore.ProjectionStoreV2["Service"]
            ]: ProjectionStore.ProjectionStoreV2["Service"][K];
          };
          const eligible: ThreadId[] = [];
          let after = "";
          for (;;) {
            const page = yield* store.getAutoTakeoverPage("running", after, 1);
            assert.isAtMost(page.length, 1);
            if (page.length === 0) break;
            after = page[0]!.threadId;
            if (page[0]!.eligible) eligible.push(page[0]!.threadId);
          }
          assert.include(eligible, live.successor);
          assert.notInclude(eligible, settled.successor);
          assert.notInclude(eligible, archived.successor);
          const sql = yield* SqlClient.SqlClient;
          const plan =
            yield* sql`EXPLAIN QUERY PLAN SELECT DISTINCT thread_id FROM orchestration_v2_projection_runs
          INDEXED BY orchestration_v2_projection_runs_recovery_idx
          WHERE status IN ('queued','preparing','starting','running','waiting') AND status = 'running'
            AND thread_id > '' ORDER BY thread_id LIMIT 1`;
          assert.include(JSON.stringify(plan), "orchestration_v2_projection_runs_recovery_idx");
          yield* Effect.log("auto takeover seed plan", JSON.stringify(plan));
          // Schedule while live, then settle while the attempt waits for P's admission lock.
          const release = yield* holdLocks([live.predecessor]);
          const trying = yield* autoLogged("Auto takeover trying");
          const ended = yield* autoTakeoverEnded(live.successor);
          yield* orchestrator.recoverDelegatedTasks.pipe(
            Effect.provideService(AutoTakeoverSettings, {
              enabled: true,
              attempts: 1,
              retrySpacingMs: 0,
              seedBatchSize: 1,
            }),
          );
          yield* trying;
          yield* mark(live.successor);
          yield* release;
          yield* ended;
          // Manual takeover of both settled successors remains allowed.
          assert.isTrue((yield* takeover(settled.predecessor, settled.successor)).ok);
          yield* Effect.yieldNow;
          assert.isUndefined((yield* thread(live.predecessor)).continuedBy);
          assert.equal(ownerOf(yield* thread(live.child!)), live.predecessor);
          assert.isTrue((yield* takeover(live.predecessor, live.successor)).ok);
        }).pipe(Effect.provide(Layer.fresh(layerAutoFile(dbPath, autoTakeoverOff))));
      }).pipe(Effect.scoped),
  );

  it.effect("startup recovery does nothing while the feature is off", () =>
    Effect.gen(function* () {
      const dbPath = yield* databaseFile;
      const name = "restart-off";
      const predecessor = ThreadId.make(`${name}-p`);
      const inProcess = <A, E>(body: Effect.Effect<A, E, ProcessServices>) =>
        body.pipe(Effect.provide(Layer.fresh(layerAutoFile(dbPath, autoTakeoverOff))));
      const child = yield* inProcess(Effect.map(setupAuto(name), (setup) => setup.child));
      yield* inProcess(
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const store = (yield* ProjectionStore.ProjectionStoreV2) as {
            -readonly [
              K in keyof ProjectionStore.ProjectionStoreV2["Service"]
            ]: ProjectionStore.ProjectionStoreV2["Service"][K];
          };
          const original = store.getAutoTakeoverPage;
          let queries = 0;
          store.getAutoTakeoverPage = (...args) => {
            queries++;
            return original(...args);
          };
          yield* orchestrator.recoverDelegatedTasks;
          yield* Effect.yieldNow;
          assert.equal(queries, 0, "disabled recovery never queries candidates");
          store.getAutoTakeoverPage = original;
          assert.deepEqual(yield* orchestrator.autoTakeoversInFlight, []);
          assert.isUndefined((yield* thread(predecessor)).continuedBy);
          assert.equal(ownerOf(yield* thread(child)), predecessor);
        }),
      );
    }).pipe(Effect.scoped),
  );
});

/**
 * t3_thread_send from a moved child, through the real MCP service over these layers: a send to a
 * former owner reaches the current owner, also when a takeover commits mid-send.
 */
const layerMcpTest = OrchestratorMcpService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(RemoteDelegation.RemoteDelegation)({}),
      ServerSettings.layerTest(),
      NodeCrypto.layer,
    ),
  ),
  Layer.provideMerge(layerForwardTest),
);

/** A delegated child D of A, moved A -> B by a takeover; C is B's launched successor, E a bystander. */
const setupMovedChild = (name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projectId = ProjectId.make(`${name}-project`);
    const a = ThreadId.make(`${name}-a`);
    const b = ThreadId.make(`${name}-b`);
    const c = ThreadId.make(`${name}-c`);
    const e = ThreadId.make(`${name}-e`);
    const parent = yield* seedThread({ threadId: a, projectId, createProject: true });
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      createdBy: "agent",
      creationSource: "mcp",
      commandId: CommandId.make(`${name}-delegate`),
      parentThreadId: a,
      parentRunId: parent.runId,
      parentNodeId: parent.rootNodeId,
      task: "Investigate the migration.",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
    });
    const d = (yield* orchestrator.getThreadProjection(a)).subagents.find(
      (candidate) => candidate.childThreadId !== null,
    )!.childThreadId!;
    yield* seedThread({ threadId: b, projectId, launchedBy: a });
    assert.isTrue((yield* takeover(a, b)).ok, "A -> B");
    yield* seedThread({ threadId: c, projectId, launchedBy: b });
    yield* seedThread({ threadId: e, projectId });
    const scope: McpInvocationScope = {
      environmentId: EnvironmentId.make(`environment:${name}`),
      requestNamespace: `provider-session:${d}`,
      thread: {
        threadId: d,
        providerSessionId: `provider-session:${d}`,
        providerInstanceId: modelSelection.instanceId,
      },
      client: undefined,
      capabilities: new Set(["orchestration"]),
      issuedAt: 1,
    };
    const send = (threadId: ThreadId, tag: string) =>
      Effect.flatMap(OrchestratorMcpService.OrchestratorMcpService, (service) =>
        service.sendToThread(scope, {
          environmentId: "local",
          threadId,
          message: `Report ${tag}`,
          freshContext: true,
          clientRequestId: `${name}-${tag}`,
        } as never),
      );
    /** D's messages on `threadId`, by text. */
    const messagesFromD = (threadId: ThreadId) =>
      Effect.map(orchestrator.getThreadProjection(threadId), (projection) =>
        projection.messages
          .filter((message) => message.senderThreadId === d)
          .map((message) => message.text),
      );
    return { a, b, c, d, e, send, messagesFromD };
  });

it.layer(layerMcpTest)("t3_thread_send from a moved child", (it) => {
  it.effect("a send to a former owner lands once on the current owner, others keep theirs", () =>
    Effect.gen(function* () {
      const { a, b, c, d, e, send, messagesFromD } = yield* setupMovedChild("mcp-redirect");
      assert.isTrue((yield* takeover(b, c)).ok, "B -> C");
      assert.equal(ownerOf(yield* thread(d)), c);
      const toA = yield* send(a, "to-a");
      assert.equal(toA.threadId, c);
      assert.equal(toA.redirected?.fromThreadId, a);
      assert.equal(toA.redirected?.toThreadId, c);
      const toB = yield* send(b, "to-b");
      assert.equal(toB.threadId, c);
      assert.equal(toB.redirected?.fromThreadId, b);
      assert.equal(toB.redirected?.toThreadId, c);
      const toE = yield* send(e, "to-e");
      assert.equal(toE.threadId, e);
      assert.isUndefined(toE.redirected);
      assert.deepEqual(yield* messagesFromD(c), ["Report to-a", "Report to-b"]);
      assert.deepEqual(yield* messagesFromD(e), ["Report to-e"]);
      assert.deepEqual(yield* messagesFromD(a), []);
      assert.deepEqual(yield* messagesFromD(b), []);
    }),
  );

  it.effect("a takeover between the owner read and the dispatch sends to the new owner", () =>
    Effect.gen(function* () {
      const { a, b, c, d, send, messagesFromD } = yield* setupMovedChild("mcp-race");
      const reached = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      let reads = 0;
      probe.ownerRead = (child, owner) =>
        child === d && owner === b && reads++ === 0
          ? Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(proceed)))
          : Effect.void;
      const sending = yield* send(a, "raced").pipe(Effect.forkChild);
      yield* Deferred.await(reached);
      // D's owner read B; B -> C commits before the send reaches B's lock.
      assert.isTrue((yield* takeover(b, c)).ok, "B -> C");
      yield* Deferred.succeed(proceed, undefined);
      const sent = yield* Fiber.join(sending).pipe(Effect.ensuring(Effect.sync(resetProbe)));
      assert.equal(sent.threadId, c);
      assert.equal(sent.redirected?.fromThreadId, a);
      assert.equal(sent.redirected?.toThreadId, c);
      assert.deepEqual(yield* messagesFromD(c), ["Report raced"]);
      assert.deepEqual(yield* messagesFromD(b), []);
    }),
  );
});

/** C hands its open task to a successor as t3_thread_launch does for a delegated child. */
const handOff = (parent: ThreadId, taskId: NodeId, from: ThreadId, key: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator
      .dispatch({
        type: "delegated_task.handoff",
        createdBy: "agent",
        creationSource: "mcp",
        commandId: CommandId.make(key),
        parentThreadId: parent,
        taskId,
        fromChildThreadId: from,
        message: "Continue the migration.",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
      })
      .pipe(Effect.exit); // A refused handoff records nothing; the task row shows the outcome.
    return (yield* orchestrator.getThreadProjection(parent)).subagents.find(
      (task) => task.id === taskId,
    )!;
  });

const taskOf = (parent: ThreadId, taskId: NodeId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.getThreadProjection(parent),
  ).pipe(Effect.map((projection) => projection.subagents.find((task) => task.id === taskId)!));

it.layer(layerTest)("delegated child handoff", (it) => {
  it.effect("H1: the successor is a sibling child bound to the parent's task", () =>
    Effect.gen(function* () {
      const s = yield* setup("h1");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const task = yield* handOff(s.predecessor, s.taskId, s.child, "h1-handoff");
      const successor = task.childThreadId!;
      assert.notEqual(successor, s.child);
      assert.deepEqual(task.handedOffFrom, [s.child]);
      const projection = yield* orchestrator.getThreadProjection(successor);
      assert.equal(projection.thread.lineage.relationshipToParent, "subagent");
      assert.equal(projection.thread.lineage.parentThreadId, s.predecessor);
      assert.deepEqual(projection.thread.forkedFrom, { type: "node", nodeId: s.taskId });
      assert.equal(projection.runs.length, 1, "the successor starts on the brief");
      const item = (yield* orchestrator.getThreadProjection(s.predecessor)).turnItems.find(
        (row) => row.type === "subagent" && row.subagentId === s.taskId,
      );
      assert.equal(item?.type === "subagent" ? item.childThreadId : null, successor);
      assert.include(item?.type === "subagent" ? item.progress : "", "Handed off to successor");
    }),
  );

  it.effect("H2: only the successor's result reaches the parent, once, across a chain", () =>
    Effect.gen(function* () {
      const s = yield* setup("h2");
      const first = (yield* handOff(s.predecessor, s.taskId, s.child, "h2-a")).childThreadId!;
      // The old child's own last message after the handoff is not the task's result.
      yield* replyOnChild(s.child, "partial from the old child");
      yield* finishChild(s.child);
      assert.isNull((yield* taskOf(s.predecessor, s.taskId)).result);
      // The successor hands off again; the second successor's result is the one result.
      const second = (yield* handOff(s.predecessor, s.taskId, first, "h2-b")).childThreadId!;
      assert.notEqual(second, first);
      yield* finishChild(first);
      const between = yield* taskOf(s.predecessor, s.taskId);
      assert.isNull(between.result, "the first successor's end is not the result either");
      assert.deepEqual(between.handedOffFrom, [s.child, first]);
      yield* replyOnChild(second, "final from the last successor");
      yield* finishChild(second);
      const task = yield* taskOf(s.predecessor, s.taskId);
      assert.equal(task.result, "final from the last successor");
      assert.equal(task.status, "completed");
      assert.isTrue(notifiable(task));
    }),
  );

  it.effect("H3: task_cancel on the original task id stops the current successor", () =>
    Effect.gen(function* () {
      const s = yield* setup("h3");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const successor = (yield* handOff(s.predecessor, s.taskId, s.child, "h3-a")).childThreadId!;
      // task_cancel resolves the child from the task row, as the MCP handler does.
      const bound = (yield* taskOf(s.predecessor, s.taskId)).childThreadId!;
      assert.equal(bound, successor);
      yield* orchestrator.cancelDelegatedTask({
        parentThreadId: s.predecessor,
        taskId: s.taskId,
        command: {
          type: "thread.stop",
          commandId: CommandId.make("h3-cancel"),
          threadId: bound,
          stopDelegatedTasks: false,
        },
        stopDescendants: () => Effect.void,
      });
      const task = yield* taskOf(s.predecessor, s.taskId);
      assert.isDefined(task.cancelledRunId, "the task is cancelled");
      const successorRuns = (yield* orchestrator.getThreadProjection(successor)).runs;
      assert.isTrue(successorRuns.some((run) => run.id === task.cancelledRunId));
    }),
  );

  it.effect("H4: a finished task, a repeat and an ex-child's second launch do not rebind", () =>
    Effect.gen(function* () {
      // Finished first: no successor, the result stays the old child's.
      const done = yield* setup("h4-done");
      yield* replyOnChild(done.child, "done before the handoff");
      yield* finishChild(done.child);
      const kept = yield* handOff(done.predecessor, done.taskId, done.child, "h4-done-a");
      assert.equal(kept.childThreadId, done.child);
      assert.equal(kept.result, "done before the handoff");
      assert.isUndefined(kept.handedOffFrom);
      // A repeat of one handoff makes one successor; a second launch by C rebinds nothing.
      const s = yield* setup("h4");
      const first = (yield* handOff(s.predecessor, s.taskId, s.child, "h4-a")).childThreadId!;
      const replay = yield* handOff(s.predecessor, s.taskId, s.child, "h4-a");
      assert.equal(replay.childThreadId, first);
      const again = yield* handOff(s.predecessor, s.taskId, s.child, "h4-b");
      assert.equal(again.childThreadId, first);
      assert.deepEqual(again.handedOffFrom, [s.child]);
    }),
  );

  it.effect("H5: a handoff racing the old child's end delivers one result", () =>
    Effect.gen(function* () {
      const s = yield* setup("h5");
      yield* replyOnChild(s.child, "old child's final");
      yield* Effect.all([handOff(s.predecessor, s.taskId, s.child, "h5-a"), finishChild(s.child)], {
        concurrency: "unbounded",
      });
      const after = yield* taskOf(s.predecessor, s.taskId);
      if (after.childThreadId === s.child) {
        // The result won: no successor was bound and the result is the old child's.
        assert.equal(after.result, "old child's final");
        assert.isUndefined(after.handedOffFrom);
        return;
      }
      // The rebind won: the old child's end wrote nothing; the successor's is the one result.
      assert.isNull(after.result);
      yield* replyOnChild(after.childThreadId!, "successor's final");
      yield* finishChild(after.childThreadId!);
      assert.equal((yield* taskOf(s.predecessor, s.taskId)).result, "successor's final");
    }),
  );

  it.effect("H6: the binding persists across a restart and recovery", () =>
    Effect.gen(function* () {
      const s = yield* setup("h6");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const successor = (yield* handOff(s.predecessor, s.taskId, s.child, "h6-a")).childThreadId!;
      yield* outbox.reconcileAfterProcessLoss;
      yield* orchestrator.recoverDelegatedTasks;
      const replay = yield* handOff(s.predecessor, s.taskId, s.child, "h6-a");
      assert.equal(replay.childThreadId, successor);
      yield* replyOnChild(successor, "after restart");
      yield* finishChild(successor);
      assert.equal((yield* taskOf(s.predecessor, s.taskId)).result, "after restart");
    }),
  );
});

/** Ends `child`'s latest run as the provider would, without waiting for any result write. */
const endRun = (child: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const run = (yield* orchestrator.getThreadProjection(child)).runs.toSorted(
      (a, b) => b.ordinal - a.ordinal,
    )[0]!;
    yield* sink.write({
      events: [
        {
          id: EventId.make(`end:${run.id}`),
          type: "run.updated",
          threadId: child,
          runId: run.id,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: { ...run, status: "completed", completedAt: now },
        },
      ],
    });
  });

/** The parent's own MCP session, as delegate_task's caller. */
const parentScope = (parent: ThreadId): McpInvocationScope => ({
  environmentId: EnvironmentId.make(`environment:${parent}`),
  requestNamespace: `provider-session:${parent}`,
  thread: {
    threadId: parent,
    providerSessionId: `provider-session:${parent}`,
    providerInstanceId: modelSelection.instanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});

/** The parent's t3_thread_wait on `child` until its delegated work settles. */
const waitOn = (parent: ThreadId, child: ThreadId) =>
  Effect.flatMap(OrchestratorMcpService.OrchestratorMcpService, (service) =>
    service.waitForThread(parentScope(parent), {
      threadId: child,
      timeoutMs: 60_000,
      untilDelegatedWorkSettled: true,
    } as never),
  );
/** Joins within real time, so a wait that never follows fails instead of hanging. */
const joinWithin = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  TestClock.withLive(Fiber.join(fiber).pipe(Effect.timeout("10 seconds")));
const settleLive = TestClock.withLive(Effect.sleep("150 millis"));

it.layer(layerMcpTest)("delegated child handoff over MCP", (it) => {
  it.effect("R2-1: a handoff between task_cancel's read and its stop cancels the successor", () =>
    Effect.gen(function* () {
      const s = yield* setup("r2-cancel");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const reached = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      let reads = 0;
      probe.taskBindingRead = (_taskId, child) =>
        child === s.child && reads++ === 0
          ? Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(proceed)))
          : Effect.void;
      const cancelling = yield* service
        .cancelTask(parentScope(s.predecessor), {
          taskId: s.taskId,
          clientRequestId: "r2-cancel-key",
        } as never)
        .pipe(Effect.forkChild);
      yield* Deferred.await(reached);
      // task_cancel read C; C's handoff commits before cancellation takes the parent's lock.
      const successor = (yield* handOff(s.predecessor, s.taskId, s.child, "r2-cancel-a"))
        .childThreadId!;
      assert.notEqual(successor, s.child);
      yield* Deferred.succeed(proceed, undefined);
      const cancelled = yield* joinWithin(cancelling).pipe(
        Effect.ensuring(Effect.sync(resetProbe)),
      );
      assert.equal(cancelled.status, "cancel_requested");
      const task = yield* taskOf(s.predecessor, s.taskId);
      assert.equal(task.childThreadId, successor, "the binding stays the successor's");
      assert.isDefined(task.cancelledRunId, "the task is cancelled");
      const successorRuns = (yield* orchestrator.getThreadProjection(successor)).runs;
      assert.isTrue(
        successorRuns.some((run) => run.id === task.cancelledRunId),
        "the successor's run is the cancelled one",
      );
    }),
  );

  it.effect("R2-2a: a wait started before the handoff answers with the successor's result", () =>
    Effect.gen(function* () {
      const s = yield* setup("r2-wait-before");
      const waiting = yield* waitOn(s.predecessor, s.child).pipe(Effect.forkChild);
      yield* settleLive;
      const successor = (yield* handOff(s.predecessor, s.taskId, s.child, "r2-wb-a"))
        .childThreadId!;
      // The old child's end is not the answer.
      yield* replyOnChild(s.child, "partial from the old child");
      yield* endRun(s.child);
      yield* settleLive;
      yield* replyOnChild(successor, "final from the successor");
      const finalRun = yield* finishChild(successor);
      const result = yield* joinWithin(waiting);
      assert.equal(result.threadId, successor);
      assert.equal(result.resultRun?.runId, finalRun);
      assert.equal(result.resultRun?.status, "completed");
    }),
  );

  it.effect("R2-2b: a wait started after the handoff with the original child id follows it", () =>
    Effect.gen(function* () {
      const s = yield* setup("r2-wait-after");
      const successor = (yield* handOff(s.predecessor, s.taskId, s.child, "r2-wa-a"))
        .childThreadId!;
      yield* endRun(s.child);
      const waiting = yield* waitOn(s.predecessor, s.child).pipe(Effect.forkChild);
      yield* settleLive;
      yield* replyOnChild(successor, "final from the successor");
      const finalRun = yield* finishChild(successor);
      const result = yield* joinWithin(waiting);
      assert.equal(result.threadId, successor);
      assert.equal(result.resultRun?.runId, finalRun);
    }),
  );

  it.effect("R2-2c: a wait follows a two-successor chain to the last result", () =>
    Effect.gen(function* () {
      const s = yield* setup("r2-wait-chain");
      const waiting = yield* waitOn(s.predecessor, s.child).pipe(Effect.forkChild);
      yield* settleLive;
      const first = (yield* handOff(s.predecessor, s.taskId, s.child, "r2-wc-a")).childThreadId!;
      yield* endRun(s.child);
      const second = (yield* handOff(s.predecessor, s.taskId, first, "r2-wc-b")).childThreadId!;
      yield* replyOnChild(first, "partial from the first successor");
      yield* endRun(first);
      yield* settleLive;
      yield* replyOnChild(second, "final from the last successor");
      const finalRun = yield* finishChild(second);
      const result = yield* joinWithin(waiting);
      assert.equal(result.threadId, second);
      assert.equal(result.resultRun?.runId, finalRun);
      assert.equal(
        (yield* taskOf(s.predecessor, s.taskId)).result,
        "final from the last successor",
      );
    }),
  );
});

/**
 * Holds the old child's result finalization before it takes the parent's lock, starts the parent's
 * wait and ends the old child. Returns once the wait saw the child settle (the gate's probe) or,
 * on a build without the gate, already answered.
 */
const lateHandoffWindow = (name: string) =>
  Effect.gen(function* () {
    const s = yield* setup(name);
    const finalizing = yield* Deferred.make<void>();
    const finalize = yield* Deferred.make<void>();
    const sawSettled = yield* Deferred.make<void>();
    let reads = 0;
    probe.ownerRead = (child) =>
      child === s.child && reads++ === 0
        ? Deferred.succeed(finalizing, undefined).pipe(Effect.andThen(Deferred.await(finalize)))
        : Effect.void;
    probe.waitChildSettled = (taskId, child) =>
      taskId === s.taskId && child === s.child
        ? Deferred.succeed(sawSettled, undefined).pipe(Effect.asVoid)
        : Effect.void;
    const waiting = yield* waitOn(s.predecessor, s.child).pipe(Effect.forkChild);
    yield* replyOnChild(s.child, "old child's final");
    yield* endRun(s.child);
    yield* TestClock.withLive(Deferred.await(finalizing).pipe(Effect.timeout("10 seconds")));
    yield* TestClock.withLive(
      Effect.raceFirst(Deferred.await(sawSettled), Effect.asVoid(Fiber.await(waiting))).pipe(
        Effect.timeout("10 seconds"),
      ),
    );
    return { ...s, waiting, releaseFinalize: Deferred.succeed(finalize, undefined) };
  });

it.layer(layerMcpTest)("delegated child handoff during the old child's finalization", (it) => {
  it.effect(
    "R2b-1a: a handoff after the old child settled, before its result, moves the wait",
    () =>
      Effect.gen(function* () {
        const s = yield* lateHandoffWindow("r2b-late");
        // The wait saw C settle while P's task is still open; C's handoff wins P's lock.
        const successor = (yield* handOff(s.predecessor, s.taskId, s.child, "r2b-late-a"))
          .childThreadId!;
        assert.notEqual(successor, s.child, "the handoff commits before finalization");
        yield* s.releaseFinalize;
        yield* replyOnChild(successor, "final from the successor");
        const finalRun = yield* finishChild(successor);
        const result = yield* joinWithin(s.waiting).pipe(Effect.ensuring(Effect.sync(resetProbe)));
        assert.equal(result.threadId, successor, "the wait answers for the successor");
        assert.equal(result.resultRun?.runId, finalRun);
        assert.isFalse(result.timedOut);
        assert.equal((yield* taskOf(s.predecessor, s.taskId)).result, "final from the successor");
      }),
  );

  it.effect(
    "R2b-1b: finalization winning the lock answers the wait, and the handoff is refused",
    () =>
      Effect.gen(function* () {
        const s = yield* lateHandoffWindow("r2b-final");
        // Until P records the result, the wait has no answer.
        assert.isUndefined(s.waiting.pollUnsafe(), "the wait stays open while the task is open");
        yield* s.releaseFinalize;
        const result = yield* joinWithin(s.waiting).pipe(Effect.ensuring(Effect.sync(resetProbe)));
        assert.equal(result.threadId, s.child);
        assert.isFalse(result.timedOut);
        assert.equal(result.resultRun?.status, "completed");
        const task = yield* handOff(s.predecessor, s.taskId, s.child, "r2b-final-a");
        assert.equal(task.childThreadId, s.child, "a closed task is not handed off");
        assert.equal(task.result, "old child's final");
      }),
  );
});

it.layer(layerTest)("delegated child handoff moves the old child's own children", (it) => {
  it.effect("R2-4: the successor takes over the old child's app-owned children", () =>
    Effect.gen(function* () {
      const s = yield* setup("r2-grand");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const childRun = (yield* orchestrator.getThreadProjection(s.child)).runs.toSorted(
        (a, b) => b.ordinal - a.ordinal,
      )[0]!;
      yield* orchestrator.dispatch({
        type: "delegated_task.request",
        createdBy: "agent",
        creationSource: "mcp",
        commandId: CommandId.make("r2-grand-subtask"),
        parentThreadId: s.child,
        parentRunId: childRun.id,
        parentNodeId: childRun.rootNodeId!,
        task: "Check the schema.",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        completionWake: "always",
      });
      const grandchild = (yield* orchestrator.getThreadProjection(s.child)).subagents.find(
        (task) => task.childThreadId !== null,
      )!.childThreadId!;
      const successor = (yield* handOff(s.predecessor, s.taskId, s.child, "r2-grand-a"))
        .childThreadId!;
      assert.equal((yield* thread(successor)).launchedBy?.threadId, s.child);
      const outcome = yield* takeover(s.child, successor);
      assert.isTrue(outcome.ok, outcome.ok ? "" : outcome.message);
      assert.equal(ownerOf(yield* thread(grandchild)), successor);
      // The task itself stays bound to the successor under the original parent.
      assert.equal((yield* taskOf(s.predecessor, s.taskId)).childThreadId, successor);
    }),
  );

  it.effect("R2b-2: after an owner takeover, the successor still takes over the grandchild", () =>
    Effect.gen(function* () {
      // A (predecessor) owns C; C owns G. A -> B moves C to B, but C's lineage parent stays A.
      const s = yield* setup("r2b-grand");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const childRun = (yield* orchestrator.getThreadProjection(s.child)).runs.toSorted(
        (a, b) => b.ordinal - a.ordinal,
      )[0]!;
      yield* orchestrator.dispatch({
        type: "delegated_task.request",
        createdBy: "agent",
        creationSource: "mcp",
        commandId: CommandId.make("r2b-grand-subtask"),
        parentThreadId: s.child,
        parentRunId: childRun.id,
        parentNodeId: childRun.rootNodeId!,
        task: "Check the schema.",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        completionWake: "always",
      });
      const grandTask = (yield* orchestrator.getThreadProjection(s.child)).subagents.find(
        (task) => task.childThreadId !== null,
      )!;
      const grandchild = grandTask.childThreadId!;
      const moved = yield* takeover(s.predecessor, s.successor);
      assert.isTrue(moved.ok, moved.ok ? "" : moved.message);
      assert.equal(ownerOf(yield* thread(s.child)), s.successor, "A -> B moved C to B");
      // C hands its task (now B's, under a new anchor id) to a successor S, a subagent of B.
      const onB = (yield* orchestrator.getThreadProjection(s.successor)).subagents.find(
        (task) => task.childThreadId === s.child,
      )!;
      const successor = (yield* handOff(s.successor, onB.id, s.child, "r2b-grand-a"))
        .childThreadId!;
      assert.notEqual(successor, s.child, "the handoff under B rebinds");
      assert.equal((yield* thread(successor)).lineage.parentThreadId, s.successor);
      const outcome = yield* takeover(s.child, successor);
      assert.isTrue(outcome.ok, outcome.ok ? "" : outcome.message);
      assert.equal(ownerOf(yield* thread(grandchild)), successor);
      // G's result lands once, on S's task; C's task was closed by the move, not by the result.
      yield* replyOnChild(grandchild, "schema checked");
      const runId = yield* finishChild(grandchild);
      const onSuccessor = (yield* orchestrator.getThreadProjection(successor)).subagents.filter(
        (task) => task.childThreadId === grandchild && task.result !== null,
      );
      assert.deepEqual(
        onSuccessor.map((task) => task.result),
        ["schema checked"],
      );
      assert.isTrue(notifiable(yield* recordedTask(successor, grandchild, runId)));
      const onChild = (yield* orchestrator.getThreadProjection(s.child)).subagents.find(
        (task) => task.id === grandTask.id,
      )!;
      assert.equal(onChild.transferredTo?.threadId, successor);
      assert.equal(onChild.completionDelivery?.state, "disposed");
    }),
  );
});

/** Every delegated-task child thread in the database (one test per database file). */
const delegatedChildren = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly threadId: string }>`
    SELECT thread_id AS threadId FROM orchestration_v2_projection_threads
    WHERE thread_id LIKE 'thread:delegated-task:%'`;
  return rows.map((row) => row.threadId);
});
/** What the parent was told about the task: its result, delivery and the parent's messages. */
const deliveredToParent = (parent: ThreadId, taskId: NodeId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(parent);
    const task = projection.subagents.find((row) => row.id === taskId)!;
    return {
      result: task.result,
      resultRunId: task.resultRunId,
      delivery: task.completionDelivery?.state,
      parentMessages: projection.messages.length,
    };
  });

it.layer(NodeServices.layer)("delegated child handoff across a real restart", (it) => {
  it.effect("R2-3: a handoff committed before its start effect ran recovers to one result", () =>
    Effect.gen(function* () {
      const dbPath = yield* databaseFile;
      const inProcess = processOver(dbPath);
      // Process 1: the handoff commits, then the process dies before any effect runs.
      const first = yield* inProcess(
        Effect.gen(function* () {
          const s = yield* setup("r2-restart");
          const successor = (yield* handOff(s.predecessor, s.taskId, s.child, "r2-restart-a"))
            .childThreadId!;
          return { ...s, successor };
        }),
      );
      // Process 2: fresh services over the same file; startup recovery runs the start effect.
      const delivered = yield* inProcess(
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* startupAfterProcessLoss;
          const task = yield* taskOf(first.predecessor, first.taskId);
          assert.equal(task.childThreadId, first.successor, "the binding persisted");
          assert.deepEqual(task.handedOffFrom, [first.child]);
          const item = (yield* orchestrator.getThreadProjection(first.predecessor)).turnItems.find(
            (row) => row.type === "subagent" && row.subagentId === first.taskId,
          );
          assert.equal(item?.type === "subagent" ? item.childThreadId : null, first.successor);
          // A replay after the lost response makes nothing new.
          const replay = yield* handOff(
            first.predecessor,
            first.taskId,
            first.child,
            "r2-restart-a",
          );
          assert.equal(replay.childThreadId, first.successor);
          assert.sameMembers(yield* delegatedChildren, [first.child, first.successor]);
          yield* replyOnChild(first.child, "old child's late message");
          yield* endRun(first.child);
          yield* replyOnChild(first.successor, "final after restart");
          yield* finishChild(first.successor);
          const delivered = yield* deliveredToParent(first.predecessor, first.taskId);
          assert.equal(delivered.result, "final after restart");
          assert.isTrue(notifiable(yield* taskOf(first.predecessor, first.taskId)));
          return delivered;
        }),
      );
      // Process 3: startup again adds no successor and no second result.
      yield* inProcess(
        Effect.gen(function* () {
          yield* startupAfterProcessLoss;
          assert.sameMembers(yield* delegatedChildren, [first.child, first.successor]);
          assert.deepEqual(yield* deliveredToParent(first.predecessor, first.taskId), delivered);
        }),
      );
    }).pipe(Effect.scoped),
  );
});
