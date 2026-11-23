// Slice B WP2 + WP3 (plan-b-r6 §3-§6, §9): the bounded synchronous takeover, its one-transaction
// commit, guard G, the forward effect, durable obligations and the live reconciler, against the
// real EventSink, projections, outbox and effect worker. `[F]` assertions are red on cc15112571
// through the baseline adapter below; `[G]` pass on both; `[N]` run on the branch.
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Subagent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as DelegatedTaskQuestionReactor from "./DelegatedTaskQuestionReactor.ts";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
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
import * as ProviderTurnStartServiceTestkit from "./ProviderTurnStartService.testkit.ts";
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
    openSession: () => Effect.die("sessions are not used by takeover tests"),
  } as ProviderAdapter.ProviderAdapterV2["Service"],
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const layerTest = Layer.mergeAll(
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
  Layer.provideMerge(SqlitePersistence.layerMemory),
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
);

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
 */
const finishChild = (child: ThreadId, status: "completed" | "failed" = "completed") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const run = (yield* orchestrator.getThreadProjection(child)).runs.toSorted(
      (a, b) => b.ordinal - a.ordinal,
    )[0]!;
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
};
const resetProbe = () => {
  probe.ownerRead = () => Effect.void;
  probe.ownerLocked = () => Effect.succeed("check");
  probe.beforeForwardCommit = () => Effect.void;
  probe.reconcilerPassed = () => Effect.void;
};
const TakeoverProbe = Context.Reference<typeof probe>("t3/orchestration-v2/ThreadTakeoverProbe", {
  defaultValue: () => probe,
});
// Merged: the reactors read it from the layer, a test-driven worker from the test's context.
const layerForwardTest = layerTest.pipe(
  Layer.provideMerge(
    Layer.succeed(TakeoverProbe, {
      ownerRead: (child, owner) => Effect.suspend(() => probe.ownerRead(child, owner)),
      ownerLocked: (child, owner) => Effect.suspend(() => probe.ownerLocked(child, owner)),
      beforeForwardCommit: (input) => Effect.suspend(() => probe.beforeForwardCommit(input)),
      reconcilerPassed: () => Effect.suspend(() => probe.reconcilerPassed()),
    }),
  ),
);

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

/** Ends C's latest run as the provider would, without waiting for its result. */
const endChildRun = (child: ThreadId, status: "completed" | "failed" = "completed") =>
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
const parkOtherEffects = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`
    UPDATE orchestration_v2_effect_outbox SET status = 'cancelled', lease_owner = NULL
    WHERE status IN ('pending', 'running') AND effect_type != 'takeover.forward'
  `,
);

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
});
