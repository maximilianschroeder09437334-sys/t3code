import { assert, it } from "@effect/vitest";
import {
  HandoffInput,
  CommandId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  type HandoffRequest,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Projects from "./ProjectStore.ts";
import * as ManagedFolders from "../project/ManagedProjectFolders.ts";
import {
  contextRolloverLimitMessage,
  contextRolloverInstructions,
  contextHandoffNudgeMessage,
} from "./ContextRollover.ts";
import * as CoreHandoff from "./CoreHandoff.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Threads from "./ThreadManagementService.ts";
import * as Launches from "./ThreadLaunchService.ts";
import * as ActivityLedger from "../activity/ActivityLedger.ts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as EffectWorker from "./EffectWorker.ts";
import * as Receipts from "./CommandReceiptStore.ts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as TestClock from "effect/testing/TestClock";
import * as Sqlite from "../persistence/Sqlite.ts";

const isHandoff = Schema.is(HandoffInput);
const handoff: HandoffInput = {
  goal: "Finish relay",
  decisions: [{ decision: "Use outbox", why: "Survive restart" }],
  state: { branch: "feature", commits: [], verified: ["source tests"] },
  deadEnds: [],
  next: "Review source",
  pointers: [],
};
const sourceId = ThreadId.make("thread:source");
const projectId = ProjectId.make("project:test");
const selection = {
  instanceId: "codex" as HandoffRequest["modelSelection"]["instanceId"],
  model: "test-model",
  options: [{ id: "effort", value: "medium" }],
};
const source = () =>
  ({
    thread: {
      id: sourceId,
      projectId,
      branch: "feature",
      worktreePath: "/workspace",
      modelSelection: selection,
      runtimeMode: "full-access",
      interactionMode: "default",
      deletedAt: null,
      archivedAt: null,
      settledOverride: null,
    },
    runs: [{ status: "completed" }],
    runtimeRequests: [],
    providerThreads: [{ pendingBackgroundTasks: [] }],
    turnItems: [],
  }) as unknown as OrchestrationV2ThreadProjection;
const storage = Layer.mergeAll(EffectOutbox.layer, ActivityLedger.layer, Receipts.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
);

it("validates the entire payload at the exact 6000 character boundary", () => {
  const n = 6000 - JSON.stringify(handoff).length;
  const exact = { ...handoff, goal: handoff.goal + "x".repeat(n) };
  assert.isTrue(isHandoff(exact));
  assert.isFalse(isHandoff({ ...exact, goal: exact.goal + "x" }));
  assert.isFalse(isHandoff({ ...handoff, decisions: [{ decision: "missing why" }] }));
});

it.effect(
  "persists one immutable request for concurrent calls and preserves it through recovery",
  () =>
    Effect.gen(function* () {
      const results = yield* Effect.all(
        [
          CoreHandoff.submitHandoff(sourceId, handoff),
          CoreHandoff.submitHandoff(sourceId, handoff),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(results[0].successorThreadId, results[1].successorThreadId);
      const conflict = yield* CoreHandoff.submitHandoff(sourceId, {
        ...handoff,
        goal: "conflicting",
      }).pipe(Effect.flip);
      assert.equal(conflict._tag, "OrchestratorMcpFailure");
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const claimed = yield* outbox.claimNext({ workerId: "lost-process" });
      assert.isTrue(Option.isSome(claimed));
      yield* outbox.reconcileAfterProcessLoss;
      const recovered = yield* outbox.claimNext({ workerId: "recovery" });
      assert.isTrue(Option.isSome(recovered));
      if (Option.isSome(claimed) && Option.isSome(recovered))
        assert.equal(claimed.value.id, recovered.value.id);
    }).pipe(
      Effect.provide(
        Layer.merge(
          storage,
          Layer.mock(Threads.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(source()),
          }),
        ),
      ),
    ),
);

it.effect("deferral does not block normal effects needed for the caller to end", () =>
  Effect.gen(function* () {
    yield* CoreHandoff.submitHandoff(sourceId, handoff);
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const first = yield* outbox.claimNext({ workerId: "handoff" });
    assert.isTrue(Option.isSome(first));
    yield* outbox.enqueue([
      {
        id: "normal",
        commandId: "normal" as never,
        threadId: sourceId,
        request: { type: "terminal.cleanup" },
      },
    ]);
    const normal = yield* outbox.claimNext({ workerId: "normal" });
    assert.isTrue(Option.isSome(normal));
    if (Option.isSome(normal)) assert.equal(normal.value.id, "normal");
  }).pipe(
    Effect.provide(
      Layer.merge(
        storage,
        Layer.mock(Threads.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed(source()),
        }),
      ),
    ),
  ),
);

it.effect.each(["source", "child", "unknown-jobs", "unknown-workspace", "branch"] as const)(
  "parks after idle observation when %s state changes before delivery",
  (change) =>
    Effect.gen(function* () {
      let launches = 0;
      let activity = false;
      const idle = source();
      let observed = idle;
      let child = idle;
      const lookupEntered = yield* Deferred.make<void>();
      const releaseLookup = yield* Deferred.make<void>();
      const threads = Layer.mock(Threads.ThreadManagementService)({
        getThreadRecords: () => Effect.succeed(idle),
        getThreadProjection: (id) =>
          Effect.sync(() => {
            activity = true;
            return id === sourceId ? observed : child;
          }),
        listAppOwnedChildThreadIds: () => Effect.succeed([ThreadId.make("child")]),
        dispatch: () => Effect.die("Source ownership must be retained"),
      });
      const launchLayer = Layer.mock(Launches.ThreadLaunchService)({
        lookupCommandReceipt: () =>
          Deferred.succeed(lookupEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseLookup)),
            Effect.as(Option.none()),
          ),
        launch: (input) =>
          Effect.sync(() => {
            launches++;
            return {
              projection: {
                ...idle,
                thread: { ...idle.thread, id: input.threadId },
                messages: [{ text: input.initialMessage!.text }],
              },
            } as never;
          }),
      });
      yield* Effect.gen(function* () {
        yield* CoreHandoff.submitHandoff(sourceId, handoff);
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const row = yield* outbox.get(CoreHandoff.handoffId(sourceId));
        if (Option.isNone(row) || row.value.request.type !== "thread.handoff") return assert.fail();
        const delivery = yield* CoreHandoff.deliverHandoff(row.value.request).pipe(
          Effect.exit,
          Effect.forkChild,
        );
        yield* Deferred.await(lookupEntered);
        activity = true;
        if (change === "source")
          observed = { ...idle, runs: [{ ...idle.runs[0]!, status: "running" }] };
        if (change === "child")
          child = { ...idle, runs: [{ ...idle.runs[0]!, status: "running" }] };
        if (change === "unknown-jobs") observed = { ...idle, providerThreads: [] };
        if (change === "unknown-workspace")
          observed = { ...idle, thread: { ...idle.thread, worktreePath: null } };
        if (change === "branch")
          observed = { ...idle, thread: { ...idle.thread, branch: "changed" } };
        yield* Deferred.succeed(releaseLookup, undefined);
        const outcome = yield* Fiber.join(delivery);
        assert.isTrue(activity);
        assert.equal(launches, 0);
        assert.equal(outcome._tag, "Failure");
        assert.equal((yield* (yield* ActivityLedger.ActivityLedger).list({ limit: 10 })).length, 0);
      }).pipe(Effect.provide(Layer.merge(threads, launchLayer)));
    }).pipe(Effect.provide(storage)),
);

it.effect.each(["none", "rejected", "mismatched", "accepted-bad-ack", "read-failure"] as const)(
  "retains immutable request and old owner with bounded claimability: %s",
  (scenario) =>
    Effect.gen(function* () {
      const receipts = yield* Receipts.CommandReceiptStoreV2;
      if (!["none", "read-failure"].includes(scenario))
        yield* receipts.insertIfAbsent({
          commandId: CommandId.make(`${CoreHandoff.handoffId(sourceId)}:launch`),
          threadId:
            scenario === "mismatched"
              ? ThreadId.make("foreign")
              : ThreadId.make(`${CoreHandoff.handoffId(sourceId)}:successor`),
          commandType: "thread.create",
          status: scenario === "rejected" ? "rejected" : "accepted",
          acceptedAt: yield* DateTime.now,
          resultSequence: NonNegativeInt.make(1),
          error: null,
        });
      let launches = 0;
      const dependencies = Layer.mergeAll(
        Layer.mock(Threads.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed(source()),
          getThreadProjection: () => Effect.succeed({ ...source(), messages: [] }),
          dispatch: () => Effect.die("Must retain source"),
        }),
        Layer.mock(Launches.ThreadLaunchService)({
          lookupCommandReceipt:
            scenario === "read-failure"
              ? (commandId) => Effect.fail(new Receipts.CommandReceiptStoreReadError({ commandId }))
              : receipts.getByCommandId,
          launch: () =>
            Effect.sync(() => {
              launches++;
              throw new Error("Must not launch");
            }),
        }),
      );
      yield* Effect.gen(function* () {
        const response = yield* CoreHandoff.submitHandoff(sourceId, handoff);
        assert.equal(response.status, "awaiting_transfer");
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const threadService = yield* Threads.ThreadManagementService;
        const launchService = yield* Launches.ThreadLaunchService;
        const ledgerService = yield* ActivityLedger.ActivityLedger;
        const executor = Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, {
          execute: (effect) =>
            effect.request.type === "thread.handoff"
              ? CoreHandoff.deliverHandoff(effect.request).pipe(
                  Effect.mapError(
                    (cause) =>
                      new EffectWorker.OrchestrationEffectExecutionError({
                        effectId: effect.id,
                        effectType: effect.request.type,
                        cause,
                      }),
                  ),
                  Effect.provideService(Threads.ThreadManagementService, threadService),
                  Effect.provideService(Launches.ThreadLaunchService, launchService),
                  Effect.provideService(ActivityLedger.ActivityLedger, ledgerService),
                )
              : Effect.void,
        });
        const workers = EffectWorker.layerWithOptions({
          workerId: "worker-a",
          maxAttempts: 2,
        }).pipe(Layer.provide(executor));
        yield* Effect.gen(function* () {
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          yield* Effect.all([worker.runOnce(), worker.runOnce()], { concurrency: "unbounded" });
          yield* TestClock.adjust(Duration.seconds(1));
          yield* worker.drain();
        }).pipe(Effect.provide(workers));
        const row = yield* outbox.get(CoreHandoff.handoffId(sourceId));
        if (Option.isNone(row)) return assert.fail();
        assert.equal(row.value.status, "failed");
        assert.equal(row.value.attemptCount, scenario === "read-failure" ? 2 : 1);
        assert.deepEqual(
          row.value.request.type === "thread.handoff" && row.value.request.handoff,
          handoff,
        );
        yield* outbox.reconcileAfterProcessLoss;
        assert.isTrue(Option.isNone(yield* outbox.claimNext({ workerId: "restart" })));
        assert.equal(launches, 0);
        assert.equal((yield* (yield* ActivityLedger.ActivityLedger).list({ limit: 10 })).length, 0);
      }).pipe(Effect.provide(dependencies));
    }).pipe(Effect.provide(storage)),
);

it("names the handoff tool explicitly", () => {
  const instructions = contextRolloverInstructions("cap-run", "feature");
  assert.include(instructions, 'contextLimitWork.capRunId="cap-run"');
  assert.include(instructions, 'state.branch="feature"');
  for (const notice of [contextRolloverLimitMessage, contextHandoffNudgeMessage]) {
    assert.include(
      notice,
      "Before submitting, commit and push your work to GitHub where the project allows it, and record the pushed SHA in state.commits.",
    );
  }
  assert.include(contextHandoffNudgeMessage, "the successor starts automatically");
  assert.include(
    contextRolloverLimitMessage,
    "call the t3_handoff_submit tool (not a thread message)",
  );
});
it.effect("explains the expected handoff branch", () =>
  CoreHandoff.submitHandoff(sourceId, {
    ...handoff,
    state: { ...handoff.state, branch: "wrong" },
  }).pipe(
    Effect.flip,
    Effect.tap((error) => Effect.sync(() => assert.include(error.message, '"feature"'))),
    Effect.provide(
      Layer.merge(
        storage,
        Layer.mock(Threads.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed(source()),
        }),
      ),
    ),
  ),
);
it.effect.each(["project", "scratch", "missing"] as const)(
  "resolves a %s target without changing source guards",
  (kind) =>
    Effect.gen(function* () {
      const target =
        kind === "scratch"
          ? { type: "scratch" as const }
          : {
              type: "project" as const,
              projectId: ProjectId.make(kind === "missing" ? "missing" : "other"),
            };
      const result = yield* CoreHandoff.submitHandoff(sourceId, {
        ...handoff,
        target,
      } as HandoffInput).pipe(Effect.result);
      if (kind === "missing") {
        assert.equal(result._tag, "Failure");
        return;
      }
      assert.equal(result._tag, "Success");
      const row = Option.getOrThrow(
        yield* (yield* EffectOutbox.EffectOutboxV2).get(CoreHandoff.handoffId(sourceId)),
      );
      if (row.request.type !== "thread.handoff") return assert.fail();
      assert.equal(row.request.projectId, projectId);
      assert.equal(row.request.branch, "feature");
      assert.deepEqual((row.request as HandoffRequest & { target?: unknown }).target, {
        projectId: ProjectId.make(kind === "scratch" ? "scratch" : "other"),
        workspaceRoot: "/target",
        branch: null,
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          storage,
          Layer.mock(Threads.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(source()),
          }),
          Layer.mock(Projects.ProjectStoreV2)({
            get: (id) =>
              Effect.succeed(
                id === "missing"
                  ? Option.none()
                  : Option.some({ projectId: id, workspaceRoot: "/target" } as never),
              ),
          }),
          Layer.mock(ManagedFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/unused",
            ensureScratchProject: Effect.succeed({
              projectId: ProjectId.make("scratch") as ProjectId,
            }),
          }),
        ),
      ),
    ),
);

it.effect("accepts an untracked source with no known Git branch", () =>
  CoreHandoff.submitHandoff(sourceId, {
    ...handoff,
    state: { ...handoff.state, branch: null },
  }).pipe(
    Effect.tap((result) => Effect.sync(() => assert.isTrue(result.accepted))),
    Effect.provide(
      Layer.merge(
        storage,
        Layer.mock(Threads.ThreadManagementService)({
          getThreadRecords: () =>
            Effect.succeed({ ...source(), thread: { ...source().thread, branch: null } }),
        }),
      ),
    ),
  ),
);

it.effect("supersedes a stale request atomically on a later run and fences its old delivery", () =>
  Effect.gen(function* () {
    let current = source();
    yield* Effect.gen(function* () {
      yield* CoreHandoff.submitHandoff(sourceId, handoff);
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const old = Option.getOrThrow(yield* outbox.get(CoreHandoff.handoffId(sourceId)));
      assert.equal(old.request.type, "thread.handoff");
      yield* TestClock.adjust("1 second");
      current = {
        ...current,
        runs: [{ ...current.runs[0]!, id: "later-run", startedAt: yield* DateTime.now }],
      } as never;
      const replacement = { ...handoff, goal: "Later saved checkpoint" };
      const submitted = yield* CoreHandoff.submitHandoff(sourceId, replacement);
      assert.isTrue(submitted.accepted);
      const active = Option.getOrThrow(yield* outbox.get(CoreHandoff.handoffId(sourceId)));
      assert.equal(
        active.request.type === "thread.handoff" && active.request.handoff.goal,
        replacement.goal,
      );
      const archived = yield* outbox.listByCommandId(old.commandId);
      assert.isTrue(
        archived.some((row) => row.status === "cancelled" && row.lastError?.includes("superseded")),
      );
      const duplicate = yield* CoreHandoff.submitHandoff(sourceId, {
        ...replacement,
        goal: "Same run conflict",
      }).pipe(Effect.flip);
      assert.equal(duplicate._tag, "OrchestratorMcpFailure");
      if (old.request.type !== "thread.handoff") return assert.fail();
      const stale = yield* CoreHandoff.deliverHandoff(old.request).pipe(Effect.flip);
      assert.equal(stale._tag, "HandoffParked");
      assert.include(stale.message, "superseded");
    }).pipe(
      Effect.provide(
        Layer.mock(Threads.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed(current),
        }),
      ),
    );
  }).pipe(Effect.provide(storage)),
);
