// @effect-diagnostics nodeBuiltinImport:off -- Generates test-only Web Push client keys.
import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentId,
  type OrchestrationV2DomainEvent,
  type WebPushError,
  type WebPushSubscription,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as WebPush from "web-push";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Sessions from "../persistence/AuthSessions.ts";
import Migration from "../persistence/Migrations/083_WebPushNotifications.ts";
import HomeAutoWaitsMigration from "../persistence/Migrations/097_HomeAutoWaits.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Notifications from "./WebPushNotifications.ts";
import * as Transport from "./WebPushTransport.ts";
import { createEncryptedPushRequest } from "./WebPushTransport.ts";

function isValidVapidSignature(authorization: string, publicKey: string): boolean {
  const token = /^vapid t=([^,]+), k=([^,]+)$/u.exec(authorization)?.[1];
  if (token === undefined) return false;
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) return false;
  const point = Buffer.from(publicKey, "base64url");
  const key = NodeCrypto.createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33, 65).toString("base64url"),
    },
    format: "jwk",
  });
  return NodeCrypto.verify(
    "sha256",
    Buffer.from(`${header}.${payload}`),
    { key, dsaEncoding: "ieee-p1363" },
    Buffer.from(signature, "base64url"),
  );
}

const sessionId = AuthSessionId.make("push-session");
const threadId = ThreadId.make("push-thread");
const targetThreadId = ThreadId.make("push-target");
const pushEnvironmentId = EnvironmentId.make("push-environment");
const subscription = {
  endpoint: "https://web.push.apple.com/test-device",
  keys: { p256dh: "public-key", auth: "auth-key" },
};
function fixture(
  events: Stream.Stream<OrchestrationV2DomainEvent> = Stream.never,
  onSend?: (
    input: Parameters<Transport.WebPushTransport["Service"]["send"]>[0],
  ) => Effect.Effect<number, WebPushError>,
  vapidKeys = { publicKey: "vapid-public", privateKey: "vapid-private" },
) {
  let savedKeys: Uint8Array | undefined;
  const sent: string[] = [];
  const autoWaitMessages: Array<{ readonly text: string; readonly threadId: ThreadId }> = [];
  let status = 201;
  let revoked = false;
  const thread = {
    id: threadId,
    projectId: ProjectId.make("push-project"),
    title: "Quiet thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-test" },
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    status: "running",
    latestRunId: RunId.make("push-run"),
    latestRunHumanAuthored: false,
    pendingRuntimeRequest: null,
    archivedAt: null,
    settledOverride: null,
    updatedAt: DateTime.makeUnsafe(0),
    latestRunCompletedAt: null as DateTime.Utc | null,
    homeNeedsYou: false,
    homeAskText: null as string | null,
    homeDoneText: null as string | null,
    homeFirstNextStep: null as string | null,
    homeDashboardSection: "running" as "needs" | "waiting" | "done" | "running",
    homeAutoWaitActive: false,
    blockedOnThreadWait: false,
    activityRunStatus: "running" as "preparing" | "running" | "starting" | "waiting" | null,
    pendingBackgroundTasks: [] as ReadonlyArray<never>,
    snoozedUntil: null,
    deletedAt: null,
  };
  const shells = new Map<string, typeof thread | Record<string, unknown>>([[threadId, thread]]);
  const dependencies = Layer.mergeAll(
    Layer.mock(Secrets.ServerSecretStore)({
      get: () => Effect.sync(() => Option.fromUndefinedOr(savedKeys)),
      create: (_, value) =>
        Effect.sync(() => {
          savedKeys = value;
        }),
    }),
    Layer.mock(Sessions.AuthSessionRepository)({
      getById: () =>
        Effect.sync(() =>
          Option.some({
            revokedAt: revoked ? DateTime.makeUnsafe(0) : null,
            expiresAt: DateTime.makeUnsafe(86_400_000),
            scopes: [AuthOrchestrationReadScope],
          } as never),
        ),
    }),
    Layer.mock(Threads.ThreadManagementService)({
      getAgentAwarenessSnapshot: (id) =>
        Effect.succeed({ threads: [shells.get(id ?? threadId) ?? thread] } as never),
      getThreadShell: (id) => Effect.succeed((shells.get(id) ?? null) as never),
      getThreadProjection: () => Effect.succeed({ turnItems: [] } as never),
      sendToThread: (input) =>
        Effect.sync(() => {
          autoWaitMessages.push({ text: input.text, threadId: input.threadId });
          return {} as never;
        }),
      streamDomainEvents: events,
    }),
    Layer.mock(Projects.ProjectService)({
      getById: () => Effect.succeedSome({ title: "T3" } as never),
    }),
    Layer.succeed(Environment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(pushEnvironmentId),
    }),
    Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
    Layer.succeed(Transport.WebPushTransport, {
      generateKeys: Effect.succeed(vapidKeys),
      send: (input) =>
        onSend?.(input) ??
        Effect.sync(() => {
          sent.push(input.payload);
          return status;
        }),
    }),
  );
  return {
    makeLayer: () => Notifications.layer.pipe(Layer.provide(dependencies)),
    layer: Notifications.layer.pipe(Layer.provide(dependencies)),
    sent,
    thread,
    shells,
    autoWaitMessages,
    setStatus: (value: number) => {
      status = value;
    },
    revoke: () => {
      revoked = true;
    },
  };
}

it.effect(
  "deduplicates and bounds delivery retries, removes expired subscriptions, and rejects revoked sessions",
  () =>
    Effect.gen(function* () {
      yield* Migration;
      yield* HomeAutoWaitsMigration;
      const test = fixture();
      yield* Effect.gen(function* () {
        const service = yield* Notifications.WebPushNotifications;
        yield* service.prepare();
        const device = yield* service.subscribe(sessionId, subscription);
        const other = AuthSessionId.make("other-session");
        expect((yield* Effect.exit(service.test(other, device.id)))._tag).toBe("Failure");
        yield* service.test(sessionId, device.id);
        expect((yield* Effect.exit(service.test(sessionId, device.id)))._tag).toBe("Failure");
        test.setStatus(503);
        yield* service.deliverDue();
        yield* service.deliverDue();
        expect(test.sent).toHaveLength(1);
        expect(JSON.parse(test.sent[0]!).path).toBe("/");
        yield* TestClock.adjust("11 seconds");
        test.setStatus(201);
        yield* service.deliverDue();
        yield* service.deliverDue();
        expect(test.sent).toHaveLength(2);
        yield* TestClock.adjust("61 seconds");
        yield* service.test(sessionId, device.id);
        test.setStatus(410);
        yield* service.deliverDue();
        expect((yield* service.info(sessionId)).subscriptions[0]?.enabled).toBe(false);
        yield* TestClock.adjust("61 seconds");
        yield* service.subscribe(sessionId, subscription);
        yield* service.test(sessionId, device.id);
        test.revoke();
        yield* service.deliverDue();
        expect(test.sent).toHaveLength(3);
        expect((yield* service.info(sessionId)).subscriptions[0]?.enabled).toBe(false);
      }).pipe(Effect.provide(test.layer));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("keeps one endpoint owner after reconnecting with a new authenticated session", () =>
  Effect.gen(function* () {
    yield* Migration;
    yield* HomeAutoWaitsMigration;
    const test = fixture();
    yield* Effect.gen(function* () {
      const service = yield* Notifications.WebPushNotifications;
      yield* service.prepare();
      const original = yield* service.subscribe(sessionId, subscription);
      const replacementSession = AuthSessionId.make("replacement-session");
      const reconnected = yield* service.subscribe(replacementSession, subscription);
      expect(reconnected.id).toBe(original.id);
      expect((yield* service.info(sessionId)).subscriptions).toHaveLength(0);
      expect((yield* service.info(replacementSession)).subscriptions).toHaveLength(1);
      expect((yield* Effect.exit(service.test(sessionId, original.id)))._tag).toBe("Failure");
      yield* service.test(replacementSession, original.id);
      yield* service.deliverDue();
      expect(test.sent).toHaveLength(1);
    }).pipe(Effect.provide(test.layer));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("pushes one server-derived Needs you entry with the ask and thread target", () =>
  Effect.gen(function* () {
    yield* Migration;
    yield* HomeAutoWaitsMigration;
    const test = fixture();
    yield* Effect.gen(function* () {
      const service = yield* Notifications.WebPushNotifications;
      yield* service.prepare();
      yield* service.subscribe(sessionId, subscription);
      yield* service.publishThread(threadId);
      yield* TestClock.adjust("1 second");
      test.thread.homeNeedsYou = true;
      test.thread.homeAskText = "Review the new build";
      test.thread.updatedAt = yield* DateTime.now;
      yield* service.publishThread(threadId);
      test.thread.homeAskText = "Updated wording while still needing Maxi";
      yield* service.publishThread(threadId);
      yield* service.deliverDue();
      expect(test.sent).toHaveLength(1);
      expect(JSON.parse(test.sent[0]!)).toMatchObject({
        title: "Quiet thread",
        body: "Quiet thread: Review the new build",
        path: "/push-environment/push-thread",
      });
    }).pipe(Effect.provide(test.layer));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("persists one wait for a report and fires once when its target is done", () =>
  Effect.gen(function* () {
    yield* Migration;
    yield* HomeAutoWaitsMigration;
    const test = fixture();
    const target = {
      ...test.thread,
      id: targetThreadId,
      title: "Build thread",
      status: "running",
      latestRunId: RunId.make("target-run"),
      homeDashboardSection: "running",
    };
    test.shells.set(targetThreadId, target);
    test.thread.status = "completed";
    test.thread.activityRunStatus = null;
    test.thread.homeDashboardSection = "waiting";
    test.thread.homeFirstNextStep =
      "T3: WAIT on [Build thread](https://app.t3.codes/threads/push-environment/push-target)";
    yield* Effect.gen(function* () {
      const service = yield* Notifications.WebPushNotifications;
      const sql = yield* SqlClient.SqlClient;
      yield* service.publishThread(threadId);
      expect(yield* sql`SELECT status FROM home_auto_waits`).toEqual([{ status: "active" }]);
      test.shells.set(targetThreadId, {
        ...target,
        status: "completed",
        homeDashboardSection: "done",
        activityRunStatus: null,
      });
      yield* service.publishThread(targetThreadId);
      yield* service.publishThread(targetThreadId);
      expect(test.autoWaitMessages).toHaveLength(1);
      expect(test.autoWaitMessages[0]?.text).toContain("[Auto-wait] Build thread finished (done)");
      expect(yield* sql`SELECT status FROM home_auto_waits`).toEqual([{ status: "fired" }]);
    }).pipe(Effect.provide(test.layer));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("recovers a persisted auto-wait after the service is recreated", () =>
  Effect.gen(function* () {
    yield* Migration;
    yield* HomeAutoWaitsMigration;
    const test = fixture();
    test.shells.set(targetThreadId, {
      ...test.thread,
      id: targetThreadId,
      title: "Restart target",
      status: "running",
      latestRunId: RunId.make("target-run"),
      homeDashboardSection: "running",
    });
    test.thread.status = "completed";
    test.thread.activityRunStatus = null;
    test.thread.homeDashboardSection = "waiting";
    test.thread.homeFirstNextStep =
      "T3: WAIT on [Restart target](https://app.t3.codes/threads/push-environment/push-target)";
    yield* Effect.gen(function* () {
      const service = yield* Notifications.WebPushNotifications;
      yield* service.publishThread(threadId);
    }).pipe(Effect.provide(test.layer));

    yield* Effect.gen(function* () {
      const service = yield* Notifications.WebPushNotifications;
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT status FROM home_auto_waits`).toEqual([{ status: "active" }]);
      test.shells.set(targetThreadId, {
        ...test.shells.get(targetThreadId)!,
        status: "completed",
        homeDashboardSection: "done",
        activityRunStatus: null,
      });
      yield* service.publishThread(targetThreadId);
      expect(test.autoWaitMessages).toHaveLength(1);
    }).pipe(Effect.provide(test.makeLayer()));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("cancels an auto-wait when the waiting thread receives a user message", () =>
  Effect.gen(function* () {
    yield* Migration;
    yield* HomeAutoWaitsMigration;
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const test = fixture(Stream.fromQueue(events));
    test.shells.set(targetThreadId, {
      ...test.thread,
      id: targetThreadId,
      status: "running",
      homeDashboardSection: "running",
    });
    test.thread.status = "completed";
    test.thread.activityRunStatus = null;
    test.thread.homeDashboardSection = "waiting";
    test.thread.homeFirstNextStep =
      "T3: WAIT on [Target](https://app.t3.codes/threads/push-environment/push-target)";
    yield* Effect.gen(function* () {
      const service = yield* Notifications.WebPushNotifications;
      const sql = yield* SqlClient.SqlClient;
      yield* service.publishThread(threadId);
      yield* Queue.offer(events, {
        id: "user-message-event",
        threadId,
        occurredAt: DateTime.makeUnsafe(1),
        type: "message.updated",
        payload: { role: "user", createdBy: "user" },
      } as never);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      expect(yield* sql`SELECT status FROM home_auto_waits`).toEqual([{ status: "cancelled" }]);
    }).pipe(Effect.provide(test.layer));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "fires immediately for an already finished target and cancels when a real wait starts",
  () =>
    Effect.gen(function* () {
      yield* Migration;
      yield* HomeAutoWaitsMigration;
      const test = fixture();
      const target = {
        ...test.thread,
        id: targetThreadId,
        title: "Already done",
        status: "completed",
        latestRunId: RunId.make("target-run"),
        homeDashboardSection: "done",
        activityRunStatus: null,
      };
      test.shells.set(targetThreadId, target);
      test.thread.status = "completed";
      test.thread.activityRunStatus = null;
      test.thread.homeDashboardSection = "waiting";
      test.thread.homeFirstNextStep =
        "T3: WAIT on [Already done](https://app.t3.codes/threads/push-environment/push-target)";
      yield* Effect.gen(function* () {
        const service = yield* Notifications.WebPushNotifications;
        const sql = yield* SqlClient.SqlClient;
        yield* service.publishThread(threadId);
        expect(test.autoWaitMessages).toHaveLength(1);

        test.thread.homeFirstNextStep =
          "T3: WAIT on [Build thread](https://app.t3.codes/threads/push-environment/push-target)";
        test.thread.blockedOnThreadWait = false;
        test.thread.latestRunId = RunId.make("next-report");
        test.shells.set(targetThreadId, {
          ...target,
          status: "running",
          homeDashboardSection: "running",
        });
        yield* service.publishThread(threadId);
        test.thread.blockedOnThreadWait = true;
        yield* service.publishThread(threadId);
        expect(
          yield* sql`SELECT status FROM home_auto_waits WHERE report_run_id = 'next-report'`,
        ).toEqual([{ status: "cancelled" }]);
      }).pipe(Effect.provide(test.layer));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("guards wait cycles and keeps the cycle visible as Needs you", () =>
  Effect.gen(function* () {
    yield* Migration;
    yield* HomeAutoWaitsMigration;
    const test = fixture();
    test.thread.status = "completed";
    test.thread.activityRunStatus = null;
    test.thread.homeDashboardSection = "waiting";
    test.thread.homeFirstNextStep =
      "T3: WAIT on [Cycle target](https://app.t3.codes/threads/push-environment/push-target)";
    const target = {
      ...test.thread,
      id: targetThreadId,
      title: "Cycle target",
      status: "completed",
      latestRunId: RunId.make("target-run"),
      homeDashboardSection: "waiting",
      activityRunStatus: null,
      homeFirstNextStep:
        "T3: WAIT on [Quiet thread](https://app.t3.codes/threads/push-environment/push-thread)",
    };
    test.shells.set(targetThreadId, target);
    yield* Effect.gen(function* () {
      const service = yield* Notifications.WebPushNotifications;
      const sql = yield* SqlClient.SqlClient;
      yield* service.publishThread(targetThreadId);
      yield* service.publishThread(threadId);
      expect(yield* sql`SELECT status FROM home_auto_waits ORDER BY waiting_thread_id`).toEqual([
        { status: "active" },
        { status: "cycle" },
      ]);
      expect(test.autoWaitMessages).toHaveLength(0);
    }).pipe(Effect.provide(test.layer));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("cancels a cycle record when the waiting report is replaced", () =>
  Effect.gen(function* () {
    yield* Migration;
    yield* HomeAutoWaitsMigration;
    const test = fixture();
    test.thread.status = "completed";
    test.thread.activityRunStatus = null;
    test.thread.homeDashboardSection = "waiting";
    test.thread.homeFirstNextStep =
      "T3: WAIT on [Cycle target](https://app.t3.codes/threads/push-environment/push-target)";
    test.shells.set(targetThreadId, {
      ...test.thread,
      id: targetThreadId,
      status: "completed",
      latestRunId: RunId.make("target-run"),
      homeDashboardSection: "waiting",
      activityRunStatus: null,
      homeFirstNextStep:
        "T3: WAIT on [Quiet thread](https://app.t3.codes/threads/push-environment/push-thread)",
    });
    yield* Effect.gen(function* () {
      const service = yield* Notifications.WebPushNotifications;
      const sql = yield* SqlClient.SqlClient;
      yield* service.publishThread(targetThreadId);
      yield* service.publishThread(threadId);
      test.thread.latestRunId = RunId.make("replacement-run");
      test.thread.homeFirstNextStep = null;
      test.thread.homeDashboardSection = "waiting";
      yield* service.publishThread(threadId);
      expect(
        yield* sql`SELECT status FROM home_auto_waits WHERE waiting_thread_id = ${threadId}`,
      ).toEqual([{ status: "cancelled" }]);
    }).pipe(Effect.provide(test.layer));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("cancels an active auto-wait when a newer report no longer waits", () =>
  Effect.gen(function* () {
    yield* Migration;
    yield* HomeAutoWaitsMigration;
    const test = fixture();
    test.shells.set(targetThreadId, {
      ...test.thread,
      id: targetThreadId,
      status: "running",
      homeDashboardSection: "running",
    });
    test.thread.status = "completed";
    test.thread.activityRunStatus = null;
    test.thread.homeDashboardSection = "waiting";
    test.thread.homeFirstNextStep =
      "T3: WAIT on [Target](https://app.t3.codes/threads/push-environment/push-target)";
    yield* Effect.gen(function* () {
      const service = yield* Notifications.WebPushNotifications;
      const sql = yield* SqlClient.SqlClient;
      yield* service.publishThread(threadId);
      test.thread.latestRunId = RunId.make("replacement-run");
      test.thread.homeFirstNextStep = null;
      test.thread.homeDashboardSection = "running";
      test.thread.status = "running";
      yield* service.publishThread(threadId);
      expect(yield* sql`SELECT status FROM home_auto_waits`).toEqual([{ status: "cancelled" }]);
    }).pipe(Effect.provide(test.layer));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("does not fire an obsolete waiter after the waiting thread starts a newer report", () =>
  Effect.gen(function* () {
    yield* Migration;
    yield* HomeAutoWaitsMigration;
    const test = fixture();
    const target = {
      ...test.thread,
      id: targetThreadId,
      title: "Build thread",
      status: "running",
      latestRunId: RunId.make("target-run"),
      homeDashboardSection: "running",
    };
    test.shells.set(targetThreadId, target);
    test.thread.status = "completed";
    test.thread.activityRunStatus = null;
    test.thread.homeDashboardSection = "waiting";
    test.thread.homeFirstNextStep =
      "T3: WAIT on [Build thread](https://app.t3.codes/threads/push-environment/push-target)";
    yield* Effect.gen(function* () {
      const service = yield* Notifications.WebPushNotifications;
      const sql = yield* SqlClient.SqlClient;
      yield* service.publishThread(threadId);
      yield* sql`INSERT INTO home_auto_waits (waiting_thread_id, waiting_project_id, report_run_id, target_thread_id, target_environment_id, target_title, status, created_at, updated_at) VALUES (${threadId}, ${test.thread.projectId}, 'unrelated-waiter-run', 'other-target', ${pushEnvironmentId}, 'Other target', 'active', 0, 0)`;
      test.thread.latestRunId = RunId.make("unrelated-waiter-run");
      test.thread.homeFirstNextStep =
        "T3: WAIT on [Other target](https://app.t3.codes/threads/push-environment/other-target)";
      test.thread.homeDashboardSection = "waiting";
      test.thread.homeNeedsYou = false;
      test.shells.set(targetThreadId, {
        ...target,
        status: "completed",
        homeDashboardSection: "done",
        activityRunStatus: null,
      });
      yield* service.publishThread(targetThreadId);
      expect(test.autoWaitMessages).toHaveLength(0);
      expect(
        yield* sql`SELECT report_run_id, status FROM home_auto_waits ORDER BY report_run_id`,
      ).toEqual([
        { report_run_id: "push-run", status: "cancelled" },
        { report_run_id: "unrelated-waiter-run", status: "active" },
      ]);
    }).pipe(Effect.provide(test.layer));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("does not wake a waiter while its target is still waiting on another thread", () =>
  Effect.gen(function* () {
    yield* Migration;
    yield* HomeAutoWaitsMigration;
    const test = fixture();
    const target = {
      ...test.thread,
      id: targetThreadId,
      title: "Chained wait",
      status: "completed",
      latestRunId: RunId.make("target-run"),
      homeDashboardSection: "needs",
      activityRunStatus: null,
      homeNeedsYou: true,
      homeFirstNextStep: "Maxi: continue the build",
      homeAutoWaitActive: true,
    };
    test.shells.set(targetThreadId, target);
    test.thread.status = "completed";
    test.thread.activityRunStatus = null;
    test.thread.homeDashboardSection = "waiting";
    test.thread.homeFirstNextStep =
      "T3: WAIT on [Chained wait](https://app.t3.codes/threads/push-environment/push-target)";
    yield* Effect.gen(function* () {
      const service = yield* Notifications.WebPushNotifications;
      yield* service.publishThread(threadId);
      yield* service.publishThread(targetThreadId);
      expect(test.autoWaitMessages).toHaveLength(0);
    }).pipe(Effect.provide(test.layer));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("wakes a valid waiter when its target is settled, archived, deleted, or missing", () =>
  Effect.gen(function* () {
    yield* Migration;
    yield* HomeAutoWaitsMigration;
    const test = fixture();
    test.thread.status = "completed";
    test.thread.activityRunStatus = null;
    test.thread.homeDashboardSection = "waiting";
    test.thread.homeFirstNextStep =
      "T3: WAIT on [Finished target](https://app.t3.codes/threads/push-environment/push-target)";
    const target = {
      ...test.thread,
      id: targetThreadId,
      title: "Finished target",
      status: "completed",
      latestRunId: RunId.make("target-run"),
      homeDashboardSection: "done",
      activityRunStatus: null,
    };
    test.shells.set(targetThreadId, target);
    yield* Effect.gen(function* () {
      const service = yield* Notifications.WebPushNotifications;
      const sql = yield* SqlClient.SqlClient;
      for (const [index, update] of [
        { settledOverride: "settled" },
        { archivedAt: DateTime.makeUnsafe(2) },
        { deletedAt: DateTime.makeUnsafe(3) },
        null,
      ].entries()) {
        test.thread.latestRunId = RunId.make(`terminal-wait-${index}`);
        if (update === null) test.shells.delete(targetThreadId);
        else test.shells.set(targetThreadId, { ...target, ...update });
        yield* service.publishThread(threadId);
      }
      expect(test.autoWaitMessages).toHaveLength(4);
      expect(test.autoWaitMessages.map(({ text }) => text)).toEqual([
        expect.stringContaining("finished (settled)"),
        expect.stringContaining("finished (archived)"),
        expect.stringContaining("finished (deleted)"),
        expect.stringContaining("finished (deleted)"),
      ]);
      expect(yield* sql`SELECT status FROM home_auto_waits ORDER BY report_run_id`).toEqual([
        { status: "fired" },
        { status: "fired" },
        { status: "fired" },
        { status: "fired" },
      ]);
    }).pipe(Effect.provide(test.layer));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("sends a subscribed iPad Home alert as a signed and encrypted push payload", () =>
  Effect.gen(function* () {
    yield* Migration;
    yield* HomeAutoWaitsMigration;
    const requests: Array<ReturnType<typeof createEncryptedPushRequest>> = [];
    const vapidKeys = WebPush.generateVAPIDKeys();
    const test = fixture(
      Stream.never,
      (input) =>
        Effect.sync(() => {
          requests.push(createEncryptedPushRequest(input));
          return 201;
        }),
      vapidKeys,
    );
    const browserKeys = NodeCrypto.createECDH("prime256v1");
    browserKeys.generateKeys();
    const browserSubscription: WebPushSubscription = {
      endpoint: "https://web.push.apple.com/mock-home-client",
      keys: {
        p256dh: browserKeys.getPublicKey().toString("base64url"),
        auth: NodeCrypto.randomBytes(16).toString("base64url"),
      },
    };
    yield* Effect.gen(function* () {
      const service = yield* Notifications.WebPushNotifications;
      yield* service.prepare();
      yield* service.subscribe(sessionId, browserSubscription);
      yield* service.publishThread(threadId);
      test.thread.homeNeedsYou = true;
      test.thread.homeAskText = "Maxi: review the build";
      yield* service.publishThread(threadId);
      yield* service.deliverDue();
      expect(requests).toHaveLength(1);
      const authorization = requests[0]?.headers.Authorization;
      if (authorization === undefined) throw new Error("Missing VAPID authorization header");
      expect(authorization).toMatch(/^vapid t=.+, k=.+$/u);
      expect(isValidVapidSignature(authorization, vapidKeys.publicKey)).toBe(true);
      expect(requests[0]?.headers["Content-Encoding"]).toBe("aes128gcm");
      expect(requests[0]?.body.length).toBeGreaterThan(80);
    }).pipe(Effect.provide(test.layer));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "suppresses internal completions and cancels stale direct-answer notifications before delivery",
  () =>
    Effect.gen(function* () {
      yield* Migration;
      yield* HomeAutoWaitsMigration;
      const test = fixture();
      yield* Effect.gen(function* () {
        const service = yield* Notifications.WebPushNotifications;
        const sql = yield* SqlClient.SqlClient;
        yield* service.prepare();
        yield* service.subscribe(sessionId, subscription);
        yield* service.publishThread(threadId);
        yield* TestClock.adjust("1 second");
        test.thread.status = "completed";
        test.thread.homeDashboardSection = "done";
        test.thread.homeDoneText = "Work is complete";
        test.thread.updatedAt = yield* DateTime.now;
        test.thread.latestRunCompletedAt = test.thread.updatedAt;
        yield* service.publishThread(threadId);
        expect(yield* sql`SELECT id FROM web_push_deliveries`).toHaveLength(0);
        test.thread.latestRunHumanAuthored = true;
        yield* service.publishThread(threadId);
        yield* service.deliverDue();
        expect(test.sent).toHaveLength(0);
        test.thread.status = "running";
        test.thread.homeDashboardSection = "running";
        yield* TestClock.adjust("6 seconds");
        yield* service.deliverDue();
        expect(test.sent).toHaveLength(0);
        test.thread.status = "completed";
        test.thread.activityRunStatus = null;
        test.thread.homeDashboardSection = "done";
        test.thread.latestRunId = RunId.make("finished-run");
        test.thread.latestRunHumanAuthored = false;
        test.thread.latestRunCompletedAt = yield* DateTime.now;
        test.thread.updatedAt = test.thread.latestRunCompletedAt;
        yield* service.publishThread(threadId);
        expect(yield* sql`SELECT event_key FROM web_push_deliveries`).toHaveLength(1);
        yield* TestClock.adjust("6 seconds");
        yield* service.deliverDue();
        expect(test.sent).toHaveLength(1);
        yield* service.publishThread(threadId);
        yield* service.deliverDue();
        expect(test.sent).toHaveLength(1);
      }).pipe(Effect.provide(test.layer));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it("rejects arbitrary and credential-bearing push endpoints", () => {
  expect(Notifications.supportedPushEndpoint(subscription.endpoint)).toBe(true);
  for (const endpoint of [
    "http://web.push.apple.com/test",
    "https://127.0.0.1/private",
    "https://web.push.apple.com.evil.test/",
    "https://user:password@web.push.apple.com/",
    "https://web.push.apple.com:8443/",
  ])
    expect(Notifications.supportedPushEndpoint(endpoint)).toBe(false);
});
