import { userRequestedPauseOrWait } from "./HandoffNextStep.ts";
import {
  CommandId,
  HookEvent,
  HookResourceLease,
  MessageId,
  ProjectId,
  RunId,
  ThreadId,
  type HookResourceInput,
  type HookRuntimeOverview,
  type HookWorkInput,
  type AgentPingInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as HookRegistry from "./HookRegistry.ts";

export class HookAutomationError extends Schema.TaggedError<HookAutomationError>()(
  "HookAutomationError",
  {
    reason: Schema.Literals([
      "storage",
      "blocked",
      "estimate-required",
      "not-owned",
      "busy",
      "stopped",
      "rate-limited",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    switch (this.reason) {
      case "rate-limited":
        return "A ping was already recorded for this thread within the last minute. Keep routine updates silent and avoid duplicate pings.";
      case "estimate-required":
        return "Give your own computer-use estimate in seconds (10 to 3600). Renew after the timer or end the backend session and report its acknowledgement.";
      case "not-owned":
        return "No matching managed resource, work item or visible parent belongs to this thread. Check its ownership before retrying.";
      case "busy":
        return "Another thread has the active computer-use lease. Finish independent work or check again after its expiry.";
      case "stopped":
        return "This thread is no longer running. A hook cannot resume stopped work.";
      case "blocked":
        return "An approved hook blocked this resource operation. Review its feedback and use a compliant approach.";
      case "storage":
        return "The durable hook state could not be read or saved.";
    }
  }
}

type Owner = { readonly projectId: ProjectId; readonly threadId: ThreadId; readonly runId: RunId };
interface LeaseRow {
  readonly id: string;
  readonly project_id: string;
  readonly thread_id: string;
  readonly run_id: string;
  readonly resource: "computer-use";
  readonly generation: number;
  readonly expires_at: number;
  readonly status: HookResourceLease["status"];
  readonly backend_ended: number;
  readonly notification: HookResourceLease["notification"];
}
const fromRow = (row: LeaseRow): HookResourceLease => ({
  id: row.id,
  projectId: ProjectId.make(row.project_id),
  threadId: ThreadId.make(row.thread_id),
  runId: RunId.make(row.run_id),
  resource: row.resource,
  generation: row.generation,
  expiresAt: row.expires_at,
  status: row.status,
  backendEnded: row.backend_ended === 1,
  notification: row.notification,
});
export class HookAutomation extends Context.Service<
  HookAutomation,
  {
    readonly ping: (
      owner: Owner,
      input: AgentPingInput,
    ) => Effect.Effect<void, HookAutomationError>;
    readonly work: (owner: Owner, input: HookWorkInput) => Effect.Effect<void, HookAutomationError>;
    readonly overview: (
      projectId: ProjectId,
    ) => Effect.Effect<HookRuntimeOverview, HookAutomationError>;

    readonly resource: (
      owner: Owner,
      input: HookResourceInput,
    ) => Effect.Effect<HookResourceLease | null, HookAutomationError>;
    readonly checkComputerUse: (
      threadId: ThreadId,
    ) => Effect.Effect<HookResourceLease, HookAutomationError>;
    readonly runDue: () => Effect.Effect<void, HookAutomationError>;
    readonly emit: (
      owner: Owner,
      event: HookEvent,
      payload: unknown,
    ) => Effect.Effect<
      { readonly allowed: boolean; readonly messages: readonly string[] },
      HookAutomationError
    >;
  }
>()("t3/hooks/HookAutomation") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const hooks = yield* HookRegistry.HookRegistry;
  const scheduler = yield* Scheduler.Scheduler;
  const lock = yield* Semaphore.make(1);
  const timerLock = yield* Semaphore.make(1);
  const overview: HookAutomation["Service"]["overview"] = Effect.fn("HookAutomation.overview")(
    function* (projectId) {
      const leases =
        yield* sql<LeaseRow>`SELECT * FROM hook_resource_leases WHERE project_id = ${projectId} ORDER BY expires_at DESC LIMIT 100`;
      const incidents = yield* sql<{
        readonly id: string;
        readonly thread_id: string;
        readonly event: string;
        readonly status: string;
        readonly updated_at: number;
        readonly attempts: number;
        readonly summary: string;
      }>`SELECT id, thread_id, event, status, updated_at, attempts, summary FROM hook_incidents WHERE project_id = ${projectId} ORDER BY updated_at DESC LIMIT 100`;
      return {
        leases: leases.map(fromRow),
        incidents: incidents.map((row) => ({
          id: row.id,
          threadId: ThreadId.make(row.thread_id),
          event: row.event,
          status: row.status,
          updatedAt: row.updated_at,
          attempts: row.attempts,
          summary: row.summary,
        })),
        checkedAt: DateTime.toEpochMillis(yield* DateTime.now),
      };
    },
    Effect.mapError((cause) => new HookAutomationError({ reason: "storage", cause })),
  );
  const read = Effect.fn("HookAutomation.read")(function* (threadId: ThreadId) {
    const rows =
      yield* sql<LeaseRow>`SELECT * FROM hook_resource_leases WHERE thread_id = ${threadId} AND resource = 'computer-use'`;
    return rows[0] === undefined ? null : fromRow(rows[0]);
  });
  const emit: HookAutomation["Service"]["emit"] = Effect.fn("HookAutomation.emit")(
    function* (owner, event, payload) {
      const result = yield* hooks.runEvent({ projectId: owner.projectId, event, payload });
      if (!result.allowed || result.messages.length > 0) {
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        const id = `${owner.threadId}:${owner.runId}:${event}`;
        yield* sql`INSERT INTO hook_incidents (id, project_id, thread_id, event, status, created_at, updated_at, summary)
          VALUES (${id}, ${owner.projectId}, ${owner.threadId}, ${event}, ${result.allowed ? "warning" : "blocked"}, ${now}, ${now}, ${result.messages.join("\n").slice(0, 2000)})
          ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, status = excluded.status, summary = excluded.summary`;
      }
      return result;
    },
    Effect.mapError((cause) => new HookAutomationError({ reason: "storage", cause })),
  );
  const resource: HookAutomation["Service"]["resource"] = Effect.fn("HookAutomation.resource")(
    function* (owner, input) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const previous = yield* read(owner.threadId);
          if (input.action === "status") return previous;
          const projection = yield* threads.getThreadRecords(owner.threadId, [
            "runs",
            "runtimeRequests",
          ]);
          const run = projection.runs.find((run) => run.id === owner.runId);
          if (run?.status !== "running")
            return yield* new HookAutomationError({ reason: "stopped" });
          if (input.action === "end") {
            if (previous === null) return null;
            yield* sql`UPDATE hook_resource_leases SET status = 'released', backend_ended = ${input.backendEnded === true ? 1 : 0}, notification = 'none' WHERE id = ${previous.id}`;
            yield* emit(owner, "resource_end", {
              ...owner,
              backendEnded: input.backendEnded === true,
            });
            return yield* read(owner.threadId);
          }
          const estimate = input.estimateSeconds;
          if (
            estimate === undefined ||
            !Number.isInteger(estimate) ||
            estimate < 10 ||
            estimate > 3600
          )
            return yield* new HookAutomationError({ reason: "estimate-required" });
          if (
            input.action === "renew" &&
            (previous === null || previous.status === "stopped" || previous.status === "released")
          )
            return yield* new HookAutomationError({ reason: "not-owned" });
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          const allowed = yield* emit(owner, "resource_start", {
            ...owner,
            estimateSeconds: estimate,
            renewal: input.action === "renew",
            reason: input.reason,
          });
          if (!allowed.allowed) return yield* new HookAutomationError({ reason: "blocked" });
          const busy =
            yield* sql`SELECT id FROM hook_resource_leases WHERE resource = 'computer-use' AND thread_id <> ${owner.threadId} AND status = 'active' AND expires_at > ${now}`;
          if (busy.length > 0) return yield* new HookAutomationError({ reason: "busy" });
          const id = `computer-use:${owner.threadId}`;
          const generation = (previous?.generation ?? 0) + 1;
          yield* sql`INSERT INTO hook_resource_leases (id, project_id, thread_id, run_id, resource, generation, expires_at, status, backend_ended, notification)
          VALUES (${id}, ${owner.projectId}, ${owner.threadId}, ${owner.runId}, 'computer-use', ${generation}, ${now + estimate * 1000}, 'active', 0, 'none')
          ON CONFLICT(thread_id, resource) DO UPDATE SET project_id = excluded.project_id, run_id = excluded.run_id, generation = excluded.generation, expires_at = excluded.expires_at, status = 'active', backend_ended = 0, notification = 'none'`;
          return yield* read(owner.threadId);
        }),
      );
    },
    Effect.mapError((cause) =>
      isHookAutomationError(cause) ? cause : new HookAutomationError({ reason: "storage", cause }),
    ),
  );
  const checkComputerUse: HookAutomation["Service"]["checkComputerUse"] = Effect.fn(
    "HookAutomation.checkComputerUse",
  )(
    function* (threadId) {
      const lease = yield* read(threadId);
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      if (lease === null || lease.status !== "active" || lease.expiresAt <= now)
        return yield* new HookAutomationError({ reason: "estimate-required" });
      return lease;
    },
    Effect.mapError((cause) =>
      isHookAutomationError(cause) ? cause : new HookAutomationError({ reason: "storage", cause }),
    ),
  );
  const ping: HookAutomation["Service"]["ping"] = Effect.fn("HookAutomation.ping")(
    function* (owner, input) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const projection = yield* threads.getThreadRecords(owner.threadId, ["runs"]);
          const source = projection.runs.find((run) => run.id === owner.runId);
          if (source?.status !== "running")
            return yield* new HookAutomationError({ reason: "stopped" });
          const targetId = projection.thread.lineage?.rootThreadId ?? owner.threadId;
          const target = yield* threads.getThreadShell(targetId);
          if (
            target === null ||
            (targetId !== owner.threadId && target.projectId !== owner.projectId)
          )
            return yield* new HookAutomationError({ reason: "not-owned" });
          if ("latestRunStopRequested" in target && target.latestRunStopRequested === true)
            return yield* new HookAutomationError({ reason: "stopped" });
          const id = `agent-ping:${owner.threadId}:${owner.runId}:${input.key}`;
          const commandId = CommandId.make(id);
          if (yield* threads.hasReceipt(commandId)) return;
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          if (
            target.agentPing !== undefined &&
            target.agentPing !== null &&
            now - target.agentPing.at < 60_000
          )
            return yield* new HookAutomationError({ reason: "rate-limited" });
          yield* threads.dispatch({
            type: "thread.metadata.update",
            threadId: targetId,
            commandId,
            agentPing: { id, title: input.title, message: input.message, at: now },
          });
        }),
      );
    },
    Effect.mapError((cause) =>
      isHookAutomationError(cause) ? cause : new HookAutomationError({ reason: "storage", cause }),
    ),
  );
  const work: HookAutomation["Service"]["work"] = Effect.fn("HookAutomation.work")(
    function* (owner, input) {
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const projection = yield* threads.getThreadRecords(owner.threadId, ["runs"]);
      if (!projection.runs.some((run) => run.id === owner.runId && run.status === "running"))
        return yield* new HookAutomationError({ reason: "stopped" });
      const status =
        input.action === "complete"
          ? "completed"
          : input.action === "cancel"
            ? "cancelled"
            : input.action === "wait"
              ? "waiting"
              : "watching";
      const id = `${owner.threadId}:${input.key}`;
      const existing = yield* sql`SELECT id FROM hook_work_obligations WHERE id = ${id}`;
      if (input.action !== "register" && existing.length === 0)
        return yield* new HookAutomationError({ reason: "not-owned" });
      yield* sql`INSERT INTO hook_work_obligations (id, project_id, thread_id, run_id, summary, status, due_at)
        VALUES (${id}, ${owner.projectId}, ${owner.threadId}, ${owner.runId}, ${input.summary}, ${status}, ${now + (input.expectedSeconds ?? 300) * 1000})
        ON CONFLICT(id) DO UPDATE SET run_id = excluded.run_id, summary = excluded.summary, status = excluded.status, due_at = excluded.due_at`;
      yield* sql`UPDATE hook_incidents SET status = ${status}, updated_at = ${now}, summary = ${input.summary} WHERE id = ${id}`;
    },
    Effect.mapError((cause) =>
      isHookAutomationError(cause) ? cause : new HookAutomationError({ reason: "storage", cause }),
    ),
  );
  const runDueWork = Effect.fn("HookAutomation.runDueWork")(function* (now: number) {
    const due = yield* sql<{
      readonly id: string;
      readonly project_id: string;
      readonly thread_id: string;
      readonly run_id: string;
      readonly summary: string;
      readonly status: string;
      readonly attempts: number;
      readonly first_failure_at: number | null;
      readonly last_delivery_id: string | null;
      readonly last_repair_prompt: string | null;
    }>`SELECT * FROM hook_work_obligations WHERE status IN ('watching', 'recovering', 'delivery_pending') AND due_at <= ${now} ORDER BY due_at LIMIT 50`;
    for (const row of due) {
      const owner = {
        projectId: ProjectId.make(row.project_id),
        threadId: ThreadId.make(row.thread_id),
        runId: RunId.make(row.run_id),
      };
      const projection = yield* threads.getThreadRecords(owner.threadId, [
        "runs",
        "messages",
        "runtimeRequests",
      ]);
      const source = projection.runs.find((run) => run.id === owner.runId);
      const lastRun = projection.runs.reduce<typeof source>(
        (latest, run) => (latest === undefined || run.ordinal > latest.ordinal ? run : latest),
        undefined,
      );
      const original = projection.messages.find((message) => message.id === source?.userMessageId);
      let status = "escalated";
      let summary = "No approved recovery policy matched this unfinished work.";
      const stopped =
        source === undefined ||
        source.status === "interrupted" ||
        source.status === "cancelled" ||
        projection.thread?.deletedAt != null;
      const waiting =
        projection.runtimeRequests.some((request) => request.status === "pending") ||
        projection.runs.some((run) => run.status === "queued" || run.queueHeld === true) ||
        original === undefined ||
        userRequestedPauseOrWait(original.text);
      if (stopped || waiting || lastRun?.id !== source?.id) {
        status = "held";
        summary = stopped
          ? "Human Stop or missing owner prevents recovery."
          : "A question, queued message, explicit wait or newer run prevents recovery.";
      } else {
        const decision = yield* hooks.runEvent({
          projectId: owner.projectId,
          event: "thread_stalled",
          payload: {
            ...owner,
            key: row.id,
            summary: row.summary,
            attempts: row.attempts,
            sourceStatus: source.status,
            overdue: true,
          },
        });
        const recovery = decision.allowed ? decision.recovery : undefined;
        const firstFailure = row.first_failure_at ?? now;
        if (
          recovery !== undefined &&
          (row.status === "delivery_pending"
            ? row.attempts <= recovery.maxAttempts
            : row.attempts < recovery.maxAttempts) &&
          now - firstFailure <= recovery.deadlineSeconds * 1000 &&
          (source.status === "running" ||
            (source.status === "completed" && recovery.allowIdleResume)) &&
          (row.status === "delivery_pending" || row.last_repair_prompt !== recovery.prompt)
        ) {
          const attempt = row.status === "delivery_pending" ? row.attempts : row.attempts + 1;
          const key =
            row.status === "delivery_pending" && row.last_delivery_id !== null
              ? row.last_delivery_id
              : `hook:work:${row.id}:${firstFailure}:${attempt}`;
          yield* sql`UPDATE hook_work_obligations SET status = 'delivery_pending', attempts = ${attempt}, first_failure_at = ${firstFailure}, last_delivery_id = ${key}, last_repair_prompt = ${recovery.prompt} WHERE id = ${row.id}`;
          const delivery = yield* threads.sendToThread({
            projectId: owner.projectId,
            threadId: owner.threadId,
            commandId: CommandId.make(key),
            messageId: MessageId.make(key),
            modelSelection: source.modelSelection,
            ...(source.status === "running"
              ? { expectedRunId: source.id }
              : {
                  hookContinuationOfRunId: source.id,
                  ...(source.hookStageWorkspaceRoot === undefined
                    ? {}
                    : { hookStageWorkspaceRoot: source.hookStageWorkspaceRoot }),
                }),
            text: `An approved hook detected an overdue work obligation: ${row.summary}\n\n${recovery.prompt}\n\nUse a distinct reversible repair and verify it. Report progress or complete/cancel the work obligation with t3_hook_work. Preserve human Stop, permissions and usage limits.`,
            attachments: [],
            mode: source.status === "running" ? "steer" : "auto",
            createdBy: "agent",
            creationSource: "server",
          });
          yield* sql`UPDATE hook_work_obligations SET status = 'recovering', run_id = ${delivery.run.id}, due_at = ${now + Math.min(30_000, recovery.deadlineSeconds * 1000)} WHERE id = ${row.id}`;
          status = "recovering";
          summary = `Recovery ${attempt}/${recovery.maxAttempts} ${delivery.delivery}; verification is still required.`;
        } else if (recovery !== undefined)
          summary =
            "Recovery held: attempt/time limits, idle-resume permission, or repeated identical repair without new evidence.";
      }
      if (status !== "recovering")
        yield* sql`UPDATE hook_work_obligations SET status = ${status} WHERE id = ${row.id}`;
      yield* sql`INSERT INTO hook_incidents (id, project_id, thread_id, event, status, created_at, updated_at, attempts, summary)
        VALUES (${row.id}, ${owner.projectId}, ${owner.threadId}, 'thread_stalled', ${status}, ${now}, ${now}, ${row.attempts + (status === "recovering" && row.status !== "delivery_pending" ? 1 : 0)}, ${summary})
        ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, attempts = excluded.attempts, summary = excluded.summary`;
    }
  });
  const runDue: HookAutomation["Service"]["runDue"] = Effect.fn("HookAutomation.runDue")(
    function* () {
      return yield* timerLock.withPermits(1)(
        Effect.gen(function* () {
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          yield* sql`UPDATE hook_resource_leases SET status = 'expired', notification = 'pending' WHERE status = 'active' AND expires_at <= ${now}`;
          const due =
            yield* sql<LeaseRow>`SELECT * FROM hook_resource_leases WHERE status = 'expired' AND notification = 'pending' ORDER BY expires_at LIMIT 50`;
          for (const row of due) {
            const lease = fromRow(row);
            const projection = yield* threads.getThreadRecords(lease.threadId, [
              "runs",
              "runtimeRequests",
            ]);
            const run = projection.runs.findLast((run) => run.status === "running");
            const source = projection.runs.find((run) => run.id === lease.runId);
            if (
              source?.status === "cancelled" ||
              source?.status === "interrupted" ||
              (projection.thread?.deletedAt !== null && projection.thread?.deletedAt !== undefined)
            ) {
              yield* sql`UPDATE hook_resource_leases SET status = 'stopped', notification = 'held' WHERE id = ${lease.id} AND generation = ${lease.generation}`;
              continue;
            }
            if (
              run?.id !== lease.runId ||
              run.status !== "running" ||
              projection.runtimeRequests.some((request) => request.status === "pending")
            ) {
              yield* sql`UPDATE hook_resource_leases SET notification = 'held' WHERE id = ${lease.id} AND generation = ${lease.generation}`;
              continue;
            }
            yield* emit(lease, "resource_expired", { ...lease, backendEnded: false });
            const key = `hook:computer-use:${lease.threadId}:${lease.generation}`;
            const delivery = yield* threads.sendToThread({
              projectId: lease.projectId,
              threadId: lease.threadId,
              commandId: CommandId.make(key),
              messageId: MessageId.make(key),
              expectedRunId: lease.runId,
              text: "Your computer-use estimate has expired. Do you still need the session? If yes, give your own new estimate and renew with t3_hook_resource before more managed computer input. If no, end the native computer-use session, then call t3_hook_resource action=end with backendEnded=true only after acknowledgement. Preserve human Stop, approvals and usage limits.",
              attachments: [],
              mode: "steer",
              createdBy: "agent",
              creationSource: "server",
            });
            yield* sql`UPDATE hook_resource_leases SET notification = ${delivery.delivery === "steered" ? "delivered" : "held"} WHERE id = ${lease.id} AND generation = ${lease.generation}`;
          }
          yield* runDueWork(now);
        }),
      );
    },
    Effect.mapError((cause) =>
      isHookAutomationError(cause) ? cause : new HookAutomationError({ reason: "storage", cause }),
    ),
  );
  yield* scheduler.register("hook-automation", runDue());
  return HookAutomation.of({ ping, work, overview, resource, checkComputerUse, runDue, emit });
});
export const layer = Layer.effect(HookAutomation, make);

const isHookAutomationError = Schema.is(HookAutomationError);
