import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentId,
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
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Sessions from "../persistence/AuthSessions.ts";
import Migration from "../persistence/Migrations/083_WebPushNotifications.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Notifications from "./WebPushNotifications.ts";
import * as Transport from "./WebPushTransport.ts";

const sessionId = AuthSessionId.make("push-session");
const threadId = ThreadId.make("push-thread");
const subscription = {
  endpoint: "https://web.push.apple.com/test-device",
  keys: { p256dh: "public-key", auth: "auth-key" },
};
function fixture() {
  let savedKeys: Uint8Array | undefined;
  const sent: string[] = [];
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
  };
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
      getAgentAwarenessSnapshot: () => Effect.succeed({ threads: [thread] } as never),
      streamDomainEvents: Stream.never,
    }),
    Layer.mock(Projects.ProjectService)({
      getById: () => Effect.succeedSome({ title: "T3" } as never),
    }),
    Layer.succeed(Environment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("push-environment")),
    }),
    Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
    Layer.succeed(Transport.WebPushTransport, {
      generateKeys: Effect.succeed({ publicKey: "vapid-public", privateKey: "vapid-private" }),
      send: (input) =>
        Effect.sync(() => {
          sent.push(input.payload);
          return status;
        }),
    }),
  );
  return {
    layer: Notifications.layer.pipe(Layer.provide(dependencies)),
    sent,
    thread,
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

it.effect(
  "suppresses internal completions and cancels stale direct-answer notifications before delivery",
  () =>
    Effect.gen(function* () {
      yield* Migration;
      const test = fixture();
      yield* Effect.gen(function* () {
        const service = yield* Notifications.WebPushNotifications;
        const sql = yield* SqlClient.SqlClient;
        yield* service.prepare();
        yield* service.subscribe(sessionId, subscription);
        yield* service.publishThread(threadId);
        yield* TestClock.adjust("1 second");
        test.thread.status = "completed";
        test.thread.updatedAt = yield* DateTime.now;
        test.thread.latestRunCompletedAt = test.thread.updatedAt;
        yield* service.publishThread(threadId);
        expect(yield* sql`SELECT id FROM web_push_deliveries`).toHaveLength(0);
        test.thread.latestRunHumanAuthored = true;
        yield* service.publishThread(threadId);
        yield* service.deliverDue();
        expect(test.sent).toHaveLength(0);
        test.thread.status = "running";
        yield* TestClock.adjust("6 seconds");
        yield* service.deliverDue();
        expect(test.sent).toHaveLength(0);
        test.thread.status = "completed";
        test.thread.latestRunCompletedAt = yield* DateTime.now;
        test.thread.updatedAt = test.thread.latestRunCompletedAt;
        yield* service.publishThread(threadId);
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
