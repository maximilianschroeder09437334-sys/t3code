import { expect, it } from "@effect/vitest";
import { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import Migration from "../persistence/Migrations/082_HookAutomation.ts";
import * as HookAutomation from "./HookAutomation.ts";
import * as HookRegistry from "./HookRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";

const owner = {
  projectId: ProjectId.make("automation-project"),
  threadId: ThreadId.make("automation-thread"),
  runId: RunId.make("automation-run"),
};
it.effect("deduplicates agent pings and prevents floods or pings after Stop", () =>
  Effect.gen(function* () {
    yield* Migration;
    let status = "running";
    let rootThreadId = owner.threadId;
    let rootStopped = false;
    const destinations: string[] = [];
    let agentPing: {
      readonly id: string;
      readonly title: string;
      readonly message: string;
      readonly at: number;
    } | null = null;
    const receipts = new Set<string>();
    const layer = HookAutomation.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadRecords: () =>
              Effect.sync(
                () =>
                  ({
                    thread: { agentPing, deletedAt: null, lineage: { rootThreadId } },
                    runs: [{ id: owner.runId, status }],
                  }) as never,
              ),
            hasReceipt: (id) => Effect.sync(() => receipts.has(id)),
            getThreadShell: () =>
              Effect.sync(
                () =>
                  ({
                    projectId: owner.projectId,
                    agentPing,
                    latestRunStopRequested: rootStopped,
                  }) as never,
              ),
            dispatch: (input) =>
              Effect.sync(() => {
                receipts.add(input.commandId);
                if (input.type === "thread.metadata.update") destinations.push(input.threadId);
                if (input.type === "thread.metadata.update" && input.agentPing != null)
                  agentPing = input.agentPing;
                return {} as never;
              }),
          }),
          Layer.mock(HookRegistry.HookRegistry)({
            runEvent: () => Effect.succeed({ allowed: true, messages: [] }),
          }),
          Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const automation = yield* HookAutomation.HookAutomation;
      const ping = {
        key: "review",
        title: "Review needed",
        message: "The exact package is ready for review.",
      };
      yield* automation.ping(owner, ping);
      yield* automation.ping(owner, ping);
      expect(receipts.size).toBe(1);
      expect((yield* Effect.exit(automation.ping(owner, { ...ping, key: "another" })))._tag).toBe(
        "Failure",
      );
      yield* TestClock.adjust("61 seconds");
      yield* automation.ping(owner, { ...ping, key: "another" });
      expect(receipts.size).toBe(2);
      status = "running";
      rootThreadId = ThreadId.make("visible-parent");
      yield* TestClock.adjust("61 seconds");
      yield* automation.ping(owner, { ...ping, key: "child-attention" });
      expect(destinations.at(-1)).toBe(rootThreadId);
      rootStopped = true;
      yield* TestClock.adjust("61 seconds");
      expect(
        (yield* Effect.exit(automation.ping(owner, { ...ping, key: "parent-stopped" })))._tag,
      ).toBe("Failure");
      expect(receipts.size).toBe(3);
      status = "interrupted";
      yield* TestClock.adjust("61 seconds");
      expect((yield* Effect.exit(automation.ping(owner, { ...ping, key: "stopped" })))._tag).toBe(
        "Failure",
      );
      expect(receipts.size).toBe(3);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
it.effect(
  "persists expiry, sends one reminder after restart, renews and preserves backend acknowledgement",
  () =>
    Effect.gen(function* () {
      yield* Migration;
      const deliveries: string[] = [];
      const dependencies = Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadRecords: () =>
            Effect.succeed({
              thread: { deletedAt: null },
              runs: [{ id: owner.runId, status: "running" }],
              runtimeRequests: [],
            } as never),
          sendToThread: (input) =>
            Effect.sync(() => {
              deliveries.push(input.commandId);
              return { delivery: "steered" } as never;
            }),
        }),
        Layer.mock(HookRegistry.HookRegistry)({
          runEvent: () => Effect.succeed({ allowed: true, messages: [] }),
        }),
        Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
      );
      const layer = HookAutomation.layer.pipe(Layer.provide(dependencies));
      yield* Effect.gen(function* () {
        const automation = yield* HookAutomation.HookAutomation;
        const lease = yield* automation.resource(owner, {
          action: "acquire",
          resource: "computer-use",
          estimateSeconds: 30,
        });
        expect(lease?.generation).toBe(1);
      }).pipe(Effect.provide(layer));
      yield* TestClock.adjust("31 seconds");
      yield* Effect.gen(function* () {
        const automation = yield* HookAutomation.HookAutomation;
        expect((yield* Effect.exit(automation.checkComputerUse(owner.threadId)))._tag).toBe(
          "Failure",
        );
        yield* automation.runDue();
        yield* automation.runDue();
        expect(deliveries).toHaveLength(1);
        const renewed = yield* automation.resource(owner, {
          action: "renew",
          resource: "computer-use",
          estimateSeconds: 60,
        });
        expect(renewed?.generation).toBe(2);
        expect(renewed?.status).toBe("active");
        const ended = yield* automation.resource(owner, {
          action: "end",
          resource: "computer-use",
          backendEnded: false,
        });
        expect(ended?.status).toBe("released");
        expect(ended?.backendEnded).toBe(false);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
it.effect("holds an expired resource after a human stop without waking the agent", () =>
  Effect.gen(function* () {
    yield* Migration;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO hook_resource_leases (id, project_id, thread_id, run_id, resource, generation, expires_at, status) VALUES ('stopped', ${owner.projectId}, ${owner.threadId}, ${owner.runId}, 'computer-use', 1, 0, 'active')`;
    const layer = HookAutomation.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadRecords: () =>
              Effect.succeed({
                thread: { deletedAt: null },
                runs: [{ id: owner.runId, status: "interrupted" }],
                runtimeRequests: [],
              } as never),
            sendToThread: () => Effect.die("Stopped work must never be resumed"),
          }),
          Layer.mock(HookRegistry.HookRegistry)({
            runEvent: () => Effect.succeed({ allowed: true, messages: [] }),
          }),
          Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const automation = yield* HookAutomation.HookAutomation;
      yield* automation.runDue();
      const lease = yield* automation.resource(owner, {
        action: "status",
        resource: "computer-use",
      });
      expect(lease?.status).toBe("stopped");
      expect(lease?.notification).toBe("held");
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("recovers registered overdue work once and escalates a repeated identical repair", () =>
  Effect.gen(function* () {
    yield* Migration;
    const deliveries: string[] = [];
    let sourceStatus = "running";
    let allowIdleResume = false;
    const layer = HookAutomation.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadRecords: () =>
              Effect.succeed({
                thread: { deletedAt: null },
                runs: [
                  { id: owner.runId, ordinal: 1, status: sourceStatus, userMessageId: "request" },
                ],
                messages: [{ id: "request", text: "Finish the authorized change." }],
                runtimeRequests: [],
              } as never),
            sendToThread: (input) =>
              Effect.sync(() => {
                if (input.mode === "steer") expect(input.expectedRunId).toBe(owner.runId);
                else expect(input.hookContinuationOfRunId).toBe(owner.runId);
                deliveries.push(input.commandId);
                return {
                  delivery: input.mode === "steer" ? "steered" : "started",
                  run: { id: owner.runId },
                } as never;
              }),
          }),
          Layer.mock(HookRegistry.HookRegistry)({
            runEvent: () =>
              Effect.succeed({
                allowed: true,
                messages: [],
                recovery: {
                  prompt: "Check the registered launch receipt and repair its working directory.",
                  allowIdleResume,
                  maxAttempts: 2,
                  deadlineSeconds: 300,
                },
              }),
          }),
          Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const automation = yield* HookAutomation.HookAutomation;
      yield* automation.work(owner, {
        action: "register",
        key: "launch",
        summary: "Wait for registered app readiness",
        expectedSeconds: 10,
      });
      yield* TestClock.adjust("11 seconds");
      yield* automation.runDue();
      expect(deliveries).toHaveLength(1);
      expect((yield* automation.overview(owner.projectId)).incidents[0]?.status).toBe("recovering");
      yield* TestClock.adjust("31 seconds");
      yield* automation.runDue();
      expect(deliveries).toHaveLength(1);
      expect((yield* automation.overview(owner.projectId)).incidents[0]?.status).toBe("escalated");
      yield* automation.work(owner, {
        action: "register",
        key: "healthy-job",
        summary: "Authorized job is running",
        expectedSeconds: 3600,
      });
      yield* automation.work(owner, {
        action: "wait",
        key: "healthy-job",
        summary: "Waiting for the job's explicit completion event",
      });
      yield* TestClock.adjust("2 hours");
      yield* automation.runDue();
      expect(deliveries).toHaveLength(1);
      yield* automation.work(owner, {
        action: "register",
        key: "idle-launch",
        summary: "Verify the unfinished launch",
        expectedSeconds: 10,
      });
      sourceStatus = "completed";
      allowIdleResume = true;
      yield* TestClock.adjust("11 seconds");
      yield* automation.runDue();
      expect(deliveries).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
