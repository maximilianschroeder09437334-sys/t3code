// @effect-diagnostics nodeBuiltinImport:off -- Digests identify private subscriptions without returning their endpoints.
import * as NodeCrypto from "node:crypto";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  CommandId,
  MessageId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  WebPushError,
  WebPushSubscription,
  ThreadId,
  isListedThreadLineage,
  type WebPushInfo,
} from "@t3tools/contracts";
import { projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import { classifyHomeNotification } from "@t3tools/shared/homeNotificationRules";
import { parseHomeNextStep } from "@t3tools/shared/homeNextStep";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import { shouldPublishThreadAttentionEvent } from "./threadAttentionEvents.ts";
import * as Transport from "./WebPushTransport.ts";

const digest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("base64url");
export function supportedPushEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      (url.port === "" || url.port === "443") &&
      (url.hostname === "web.push.apple.com" ||
        url.hostname === "fcm.googleapis.com" ||
        url.hostname === "updates.push.services.mozilla.com" ||
        url.hostname.endsWith(".notify.windows.com"))
    );
  } catch {
    return false;
  }
}
export class WebPushNotifications extends Context.Service<
  WebPushNotifications,
  {
    readonly info: (sessionId: AuthSessionId) => Effect.Effect<WebPushInfo, WebPushError>;
    readonly prepare: () => Effect.Effect<{ readonly publicKey: string }, WebPushError>;
    readonly subscribe: (
      sessionId: AuthSessionId,
      subscription: WebPushSubscription,
    ) => Effect.Effect<{ readonly id: string }, WebPushError>;
    readonly unsubscribe: (
      sessionId: AuthSessionId,
      id: string,
    ) => Effect.Effect<void, WebPushError>;
    readonly test: (sessionId: AuthSessionId, id: string) => Effect.Effect<void, WebPushError>;
    readonly publishThread: (threadId: ThreadId) => Effect.Effect<void, WebPushError>;
    readonly deliverDue: () => Effect.Effect<void, WebPushError>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/notifications/WebPushNotifications") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const sessions = yield* AuthSessions.AuthSessionRepository;
  const threads = yield* Threads.ThreadManagementService;
  const projects = yield* Projects.ProjectService;
  const environment = yield* Environment.ServerEnvironmentIdentity;
  const transport = yield* Transport.WebPushTransport;
  const scheduler = yield* Scheduler.Scheduler;
  const lock = yield* Semaphore.make(1);
  const deliveryLock = yield* Semaphore.make(1);
  const secretName = "web-push-vapid-keys";
  const decodeKeys = Schema.decodeUnknownEffect(Schema.fromJsonString(Transport.VapidKeys));
  const encodeKeys = Schema.encodeEffect(Schema.fromJsonString(Transport.VapidKeys));
  const keys = Effect.fn("WebPushNotifications.keys")(function* (create: boolean) {
    const existing = yield* secrets.get(secretName);
    if (Option.isSome(existing)) return yield* decodeKeys(new TextDecoder().decode(existing.value));
    if (!create) return null;
    const generated = yield* transport.generateKeys;
    yield* secrets.create(secretName, new TextEncoder().encode(yield* encodeKeys(generated)));
    return generated;
  });
  const storage = (cause: unknown) =>
    isWebPushError(cause) ? cause : new WebPushError({ reason: "storage", cause });
  const prepare = Effect.fn("WebPushNotifications.prepare")(
    () =>
      lock.withPermits(1)(
        keys(true).pipe(Effect.map((value) => ({ publicKey: value!.publicKey }))),
      ),
    Effect.mapError(storage),
  );
  const info: WebPushNotifications["Service"]["info"] = Effect.fn("WebPushNotifications.info")(
    function* (sessionId) {
      const key = yield* keys(false);
      const rows = yield* sql<{
        readonly id: string;
        readonly label: string;
        readonly enabled: number;
        readonly last_status: number | null;
      }>`SELECT id, label, enabled, last_status FROM web_push_subscriptions WHERE session_id = ${sessionId}`;
      return {
        publicKey: key?.publicKey ?? null,
        subscriptions: rows.map((row) => ({
          id: row.id,
          label: row.label,
          enabled: row.enabled === 1,
          lastStatus: row.last_status,
        })),
      };
    },
    Effect.mapError(storage),
  );
  const subscribe: WebPushNotifications["Service"]["subscribe"] = Effect.fn(
    "WebPushNotifications.subscribe",
  )(function* (sessionId, subscription) {
    if (!supportedPushEndpoint(subscription.endpoint))
      return yield* new WebPushError({ reason: "endpoint" });
    // One browser endpoint has one current owner, including after signing in again.
    const id = digest(subscription.endpoint);
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const encoded = yield* encodeSubscription(subscription);
    yield* sql`INSERT INTO web_push_subscriptions (id, session_id, subscription_json, label, created_at) VALUES (${id}, ${sessionId}, ${encoded}, ${subscription.label ?? "Home Screen device"}, ${now}) ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id, subscription_json = excluded.subscription_json, enabled = 1, label = excluded.label, created_at = excluded.created_at, last_status = NULL`;
    // Enabling mid-task catches its next completion without replaying old results.
    const snapshot = yield* threads.getAgentAwarenessSnapshot();
    yield* sql.withTransaction(
      Effect.forEach(
        snapshot.threads,
        (thread) =>
          sql`INSERT OR IGNORE INTO web_push_thread_state (thread_id, identity, phase, updated_at) VALUES (${thread.id}, NULL, NULL, ${now})`,
        { discard: true },
      ),
    );
    return { id };
  }, Effect.mapError(storage));
  const unsubscribe: WebPushNotifications["Service"]["unsubscribe"] = Effect.fn(
    "WebPushNotifications.unsubscribe",
  )(
    (sessionId, id) =>
      sql`UPDATE web_push_subscriptions SET enabled = 0 WHERE id = ${id} AND session_id = ${sessionId}`.pipe(
        Effect.asVoid,
      ),
    Effect.mapError(storage),
  );
  const queue = Effect.fn("WebPushNotifications.queue")(function* (
    subscriptionId: string,
    eventKey: string,
    payload: { readonly title: string; readonly body: string; readonly path: string },
    threadId: ThreadId | null = null,
    delay = 0,
  ) {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const id = digest(`${subscriptionId}:${eventKey}`);
    const body = yield* encodePushPayload({
      ...payload,
      tag: digest(eventKey).slice(0, 24),
    });
    yield* sql`INSERT OR IGNORE INTO web_push_deliveries (id, subscription_id, event_key, thread_id, payload_json, created_at, next_at, expires_at) VALUES (${id}, ${subscriptionId}, ${eventKey}, ${threadId}, ${body}, ${now}, ${now + delay}, ${now + 120_000})`;
  });
  const test: WebPushNotifications["Service"]["test"] = Effect.fn("WebPushNotifications.test")(
    function* (sessionId, id) {
      const exists =
        yield* sql`SELECT id FROM web_push_subscriptions WHERE id = ${id} AND session_id = ${sessionId} AND enabled = 1`;
      if (exists.length === 0) return yield* new WebPushError({ reason: "not-found" });
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const recent =
        yield* sql`SELECT id FROM web_push_deliveries WHERE subscription_id = ${id} AND event_key LIKE 'test:%' AND created_at > ${now - 60_000}`;
      if (recent.length > 0) return yield* new WebPushError({ reason: "rate-limited" });
      yield* queue(id, `test:${now}`, {
        title: "T3 notifications are connected",
        body: "Only direct replies, requests and important agent pings notify by default.",
        path: "/",
      });
    },
    Effect.mapError(storage),
  );
  const cancelAutoWaits = Effect.fn("WebPushNotifications.cancelAutoWaits")(function* (
    threadId: ThreadId,
  ) {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    yield* sql`UPDATE home_auto_waits SET status = 'cancelled', updated_at = ${now} WHERE waiting_thread_id = ${threadId} AND status = 'active'`;
  });
  const autoWaitTargetState = (shell: OrchestrationV2ThreadShell) => {
    const firstStep = shell.homeFirstNextStep ?? "";
    const handedOff = /^T3:\s+\[[^\]]+\]\(https:\/\/app\.t3\.codes\/threads\/[^)]+\):/iu.test(
      firstStep,
    );
    if (
      shell.archivedAt !== null ||
      shell.deletedAt != null ||
      shell.settledOverride === "settled" ||
      shell.blockedOnThreadWait ||
      shell.homeHandedOff === true ||
      firstStep.startsWith("T3: WAIT on ") ||
      handedOff ||
      (shell.pendingBackgroundTasks?.length ?? 0) > 0
    )
      return null;
    if (shell.status === "failed") return "failed";
    if (shell.homeNeedsYou) return "needs you";
    if (shell.homeDashboardSection === "done" && shell.activityRunStatus == null) return "done";
    return null;
  };
  const fireAutoWait = Effect.fn("WebPushNotifications.fireAutoWait")(function* (
    row: {
      readonly waiting_thread_id: string;
      readonly waiting_project_id: string;
      readonly report_run_id: string;
      readonly target_title: string;
    },
    targetShell: OrchestrationV2ThreadShell,
  ) {
    const waitingThreadId = ThreadId.make(row.waiting_thread_id);
    const waitingShell = yield* threads.getThreadShell(waitingThreadId);
    if (
      waitingShell === null ||
      waitingShell.archivedAt !== null ||
      waitingShell.deletedAt != null ||
      waitingShell.settledOverride === "settled" ||
      waitingShell.blockedOnThreadWait
    ) {
      yield* cancelAutoWaits(waitingThreadId);
      return;
    }
    const status = autoWaitTargetState(targetShell);
    if (status === null) return;
    const projection = yield* threads.getThreadProjection(targetShell.id);
    const latestReport = projection.turnItems
      .filter(
        (item) =>
          item.runId === targetShell.latestRunId &&
          item.type === "assistant_message" &&
          !item.streaming &&
          (item.phase === undefined || item.phase === "final_answer"),
      )
      .toSorted((left, right) => right.ordinal - left.ordinal)
      .find((item) => item.type === "assistant_message");
    const reportSummary =
      latestReport?.type === "assistant_message"
        ? latestReport.text
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .filter(Boolean)
            .slice(0, 3)
            .join(" ")
            .slice(0, 500)
        : "No report text was available.";
    const eventKey = `${row.waiting_thread_id}:${row.report_run_id}`;
    yield* threads.sendToThread({
      projectId: ProjectId.make(row.waiting_project_id),
      commandId: CommandId.make(`home-auto-wait:${digest(eventKey).slice(0, 32)}`),
      threadId: waitingThreadId,
      messageId: MessageId.make(`home-auto-wait:${digest(eventKey).slice(0, 32)}`),
      text: `[Auto-wait] ${targetShell.title} finished (${status}). Its latest report: ${reportSummary}. Continue your work.`,
      attachments: [],
      mode: "queue",
      createdBy: "system",
      creationSource: "server",
    });
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    yield* sql`UPDATE home_auto_waits SET status = 'fired', updated_at = ${now} WHERE waiting_thread_id = ${row.waiting_thread_id} AND report_run_id = ${row.report_run_id} AND status = 'active'`;
  });
  const processAutoWaits = Effect.fn("WebPushNotifications.processAutoWaits")(function* (
    threadId: ThreadId,
  ) {
    const shell = yield* threads.getThreadShell(threadId);
    const environmentId = yield* environment.getEnvironmentId;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if (
      shell === null ||
      shell.archivedAt !== null ||
      shell.deletedAt != null ||
      shell.settledOverride === "settled" ||
      shell.blockedOnThreadWait
    ) {
      yield* cancelAutoWaits(threadId);
    }
    const targetWaiters = yield* sql<{
      readonly waiting_thread_id: string;
      readonly waiting_project_id: string;
      readonly report_run_id: string;
      readonly target_title: string;
    }>`SELECT waiting_thread_id, waiting_project_id, report_run_id, target_title FROM home_auto_waits WHERE target_thread_id = ${threadId} AND target_environment_id = ${environmentId} AND status = 'active'`;
    if (shell !== null) {
      for (const waiter of targetWaiters) yield* fireAutoWait(waiter, shell);
    }
    if (
      shell === null ||
      shell.status !== "completed" ||
      shell.blockedOnThreadWait ||
      shell.archivedAt !== null ||
      shell.deletedAt != null ||
      shell.settledOverride === "settled"
    )
      return;
    const firstStep = parseHomeNextStep(shell.homeFirstNextStep ?? "");
    if (firstStep?.kind !== "wait" || firstStep.environmentId !== environmentId) return;
    const reportRunId = shell.latestRunId;
    if (!reportRunId) return;
    const targetThreadId = ThreadId.make(firstStep.threadId);
    const cycle =
      targetThreadId === threadId
        ? true
        : (yield* sql<{ readonly found: number }>`WITH RECURSIVE chain(thread_id) AS (
              SELECT ${targetThreadId}
              UNION
              SELECT waits.target_thread_id FROM home_auto_waits waits
              JOIN chain ON waits.waiting_thread_id = chain.thread_id
              WHERE waits.status = 'active'
            ) SELECT 1 AS found FROM chain WHERE thread_id = ${threadId} LIMIT 1`).length > 0;
    const targetShell = yield* threads.getThreadShell(targetThreadId);
    yield* sql`INSERT OR IGNORE INTO home_auto_waits (waiting_thread_id, waiting_project_id, report_run_id, target_thread_id, target_environment_id, target_title, status, created_at, updated_at) VALUES (${threadId}, ${shell.projectId}, ${reportRunId}, ${targetThreadId}, ${firstStep.environmentId}, ${firstStep.title}, ${cycle ? "cycle" : "active"}, ${now}, ${now})`;
    if (cycle || targetShell === null) return;
    const inserted = yield* sql<{
      readonly waiting_thread_id: string;
      readonly waiting_project_id: string;
      readonly report_run_id: string;
      readonly target_title: string;
    }>`SELECT waiting_thread_id, waiting_project_id, report_run_id, target_title FROM home_auto_waits WHERE waiting_thread_id = ${threadId} AND report_run_id = ${reportRunId} AND status = 'active'`;
    const row = inserted[0];
    if (row && autoWaitTargetState(targetShell) !== null) yield* fireAutoWait(row, targetShell);
  });
  const publishThread: WebPushNotifications["Service"]["publishThread"] = Effect.fn(
    "WebPushNotifications.publishThread",
  )(function* (threadId) {
    yield* processAutoWaits(threadId);
    const subscriptions = yield* sql<{
      readonly id: string;
      readonly created_at: number;
    }>`SELECT id, created_at FROM web_push_subscriptions WHERE enabled = 1`;
    if (subscriptions.length === 0) return;
    const thread = (yield* threads.getAgentAwarenessSnapshot(threadId)).threads[0];
    if (thread === undefined) return;
    const shell = yield* threads.getThreadShell(threadId);
    const project = yield* projects.getById(thread.projectId);
    const state =
      Option.isSome(project) && thread.archivedAt === null
        ? projectThreadAwarenessV2({
            notificationsOnly: true,
            environmentId: yield* environment.getEnvironmentId,
            project: project.value,
            thread,
          })
        : null;
    const targetEnvironmentId = state?.environmentId ?? (yield* environment.getEnvironmentId);
    const previous = yield* sql<{
      readonly identity: string | null;
      readonly phase: string | null;
    }>`SELECT identity, phase FROM web_push_thread_state WHERE thread_id = ${threadId}`;
    const shellNeedsYou = shell?.homeNeedsYou === true;
    const homeAsk = shell?.homeAskText?.trim() || null;
    const waitingStep = shell?.homeFirstNextStep?.startsWith("T3: WAIT on ") === true;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const firstStepHandoff =
      /^T3:\s+\[[^\]]+\]\(https:\/\/app\.t3\.codes\/threads\/[^)]+\):/iu.test(
        shell?.homeFirstNextStep ?? "",
      );
    const autoWait = yield* sql<{
      readonly active: number;
    }>`SELECT 1 AS active FROM home_auto_waits WHERE waiting_thread_id = ${threadId} AND status = 'active' LIMIT 1`;
    const homeEvent = classifyHomeNotification({
      threadId,
      runId: thread.latestRunId,
      isChild: thread.lineage.relationshipToParent === "subagent",
      sideChat: !isListedThreadLineage(thread.lineage),
      snoozed: shell?.snoozedUntil != null && DateTime.toEpochMillis(shell.snoozedUntil) > now,
      settled: shell?.settledOverride === "settled",
      needsYou: shellNeedsYou,
      askText: homeAsk,
      turnCompleted: shell?.status === "completed" && shell.activityRunStatus == null,
      hasRunningChildren: (shell?.pendingBackgroundTasks?.length ?? 0) > 0,
      waiting: waitingStep || shell?.blockedOnThreadWait === true,
      hasAutoWait: autoWait.length > 0,
      handedOff: firstStepHandoff || shell?.homeHandedOff === true,
      doneText: shell?.homeDoneText ?? state?.detail ?? null,
    });
    const homeNeedsYou = homeEvent?.kind === "needs";
    const notificationIdentity =
      homeEvent?.kind === "needs"
        ? `needs:${threadId}:${thread.latestRunId ?? "unknown"}`
        : (homeEvent?.key ?? `${state?.phase ?? ""}:${thread.agentPing?.id ?? ""}`);
    const identity =
      homeEvent !== null
        ? `${thread.latestRunId}:${notificationIdentity}`
        : state === null
          ? null
          : `${thread.latestRunId}:${state.phase}:${thread.agentPing?.id ?? ""}:${state.phase.startsWith("waiting_") ? (thread.pendingRuntimeRequest?.id ?? "") : thread.latestRunCompletedAt == null ? "" : DateTime.formatIso(thread.latestRunCompletedAt)}`;
    if (previous[0]?.identity === identity) return;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO web_push_thread_state (thread_id, identity, phase, updated_at) VALUES (${threadId}, ${identity}, ${state?.phase ?? null}, ${now}) ON CONFLICT(thread_id) DO UPDATE SET identity = excluded.identity, phase = excluded.phase, updated_at = excluded.updated_at`;
        if (previous.length === 0 || identity === null) return;
        const attention =
          homeNeedsYou ||
          state?.phase === "waiting_for_input" ||
          state?.phase === "waiting_for_approval";
        const terminal =
          state?.phase === "failed" ||
          (homeEvent?.kind === "done" && (state === null || state.phase === "completed"));
        if (!attention && !terminal) return;
        if (state !== null && Date.parse(state.updatedAt) < now - 120_000) return;
        for (const subscription of subscriptions) {
          if (state !== null && Date.parse(state.updatedAt) < subscription.created_at) continue;
          yield* queue(
            subscription.id,
            identity,
            {
              title: homeNeedsYou ? thread.title : (state?.headline ?? thread.title),
              body: homeNeedsYou
                ? `${thread.title}${homeAsk ? `: ${homeAsk}` : ": Needs you"}`
                : homeEvent?.kind === "done"
                  ? `Done: ${homeEvent.text}`
                  : `${state?.threadTitle ?? thread.title}${state?.detail ? `: ${state.detail}` : ""}`,
              path: `/${encodeURIComponent(targetEnvironmentId)}/${encodeURIComponent(threadId)}`,
            },
            threadId,
            terminal ? 5_000 : 0,
          );
        }
      }),
    );
  }, Effect.mapError(storage));
  const deliverDue: WebPushNotifications["Service"]["deliverDue"] = Effect.fn(
    "WebPushNotifications.deliverDue",
  )(
    function* () {
      const key = yield* keys(false);
      if (key === null) return;
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const due = yield* sql<{
        readonly id: string;
        readonly subscription_id: string;
        readonly payload_json: string;
        readonly attempts: number;
        readonly expires_at: number;
        readonly subscription_json: string;
        readonly session_id: string;
        readonly thread_id: string | null;
        readonly event_key: string;
      }>`SELECT d.*, s.subscription_json, s.session_id FROM web_push_deliveries d JOIN web_push_subscriptions s ON s.id = d.subscription_id WHERE d.status = 'pending' AND d.next_at <= ${now} AND s.enabled = 1 ORDER BY d.next_at LIMIT 50`;
      for (const row of due) {
        const session = yield* sessions.getById({ sessionId: AuthSessionId.make(row.session_id) });
        const unauthorized =
          Option.isNone(session) ||
          session.value.revokedAt !== null ||
          DateTime.toEpochMillis(session.value.expiresAt) <= now ||
          !session.value.scopes.includes(AuthOrchestrationReadScope);
        if (row.expires_at <= now || unauthorized) {
          yield* sql`UPDATE web_push_deliveries SET status = 'expired' WHERE id = ${row.id}`;
          if (unauthorized)
            yield* sql`UPDATE web_push_subscriptions SET enabled = 0 WHERE id = ${row.subscription_id}`;
          continue;
        }
        if (row.thread_id !== null) {
          // Re-project after the completion grace period; a continuation, Stop,
          // acknowledgement or answered question makes the old push obsolete.
          yield* publishThread(ThreadId.make(row.thread_id));
          const state = yield* sql<{
            readonly identity: string | null;
          }>`SELECT identity FROM web_push_thread_state WHERE thread_id = ${row.thread_id}`;
          if (state[0]?.identity !== row.event_key) {
            yield* sql`UPDATE web_push_deliveries SET status = 'obsolete' WHERE id = ${row.id}`;
            continue;
          }
        }
        const subscription = yield* decodeSubscription(row.subscription_json);
        const status = yield* transport
          .send({ subscription, keys: key, payload: row.payload_json, topic: row.id.slice(0, 24) })
          .pipe(Effect.orElseSucceed(() => 0));
        const accepted = status >= 200 && status < 300;
        const expired = status === 404 || status === 410;
        const retry =
          !accepted &&
          !expired &&
          (status === 0 || status === 429 || status >= 500) &&
          row.attempts < 2;
        yield* sql`UPDATE web_push_deliveries SET status = ${accepted ? "accepted" : retry ? "pending" : "failed"}, attempts = attempts + 1, last_status = ${status}, next_at = ${now + 10_000} WHERE id = ${row.id}`;
        yield* sql`UPDATE web_push_subscriptions SET last_status = ${status} WHERE id = ${row.subscription_id}`;
        if (expired)
          yield* sql`UPDATE web_push_subscriptions SET enabled = 0 WHERE id = ${row.subscription_id}`;
      }
      yield* sql`DELETE FROM web_push_deliveries WHERE expires_at < ${now - 86_400_000}`;
    },
    deliveryLock.withPermits(1),
    Effect.mapError(storage),
  );
  const worker = yield* makeDrainableWorker(publishThread);
  yield* scheduler.register("web-push-deliveries", deliverDue());
  const activeAutoWaits = yield* sql<{
    readonly waiting_thread_id: string;
    readonly target_thread_id: string;
  }>`SELECT waiting_thread_id, target_thread_id FROM home_auto_waits WHERE status = 'active'`;
  for (const wait of activeAutoWaits) {
    yield* worker.enqueue(ThreadId.make(wait.waiting_thread_id));
    yield* worker.enqueue(ThreadId.make(wait.target_thread_id));
  }
  yield* worker.drain;
  yield* forkParked(
    Stream.runForEach(threads.streamDomainEvents, (event) => {
      if (
        event.type === "message.updated" &&
        event.payload.role === "user" &&
        event.payload.createdBy === "user"
      )
        return cancelAutoWaits(event.threadId);
      return shouldPublishThreadAttentionEvent(event)
        ? worker.enqueue(event.threadId)
        : Effect.void;
    }),
  );
  return WebPushNotifications.of({
    info,
    prepare,
    subscribe,
    unsubscribe,
    test,
    publishThread,
    deliverDue,
    drain: worker.drain,
  });
});
export const layer = Layer.effect(WebPushNotifications, make);

const isWebPushError = Schema.is(WebPushError);

const encodeSubscription = Schema.encodeEffect(Schema.fromJsonString(WebPushSubscription));

const decodeSubscription = Schema.decodeEffect(Schema.fromJsonString(WebPushSubscription));

const encodePushPayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));
