// Slice B WP2 (plan-b-r6 §3, §4, §9): the bounded synchronous takeover and its one-transaction
// commit, against the real EventSink, projections and outbox. `[F]` assertions are red on
// cc15112571 through the baseline adapter below; `[G]` pass on both; `[N]` run on the branch.
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
  type OrchestrationV2Subagent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
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
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
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
  Layer.provide(SqlitePersistence.layerMemory),
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
    yield* Fiber.join(settled);
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
