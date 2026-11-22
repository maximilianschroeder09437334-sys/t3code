import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { activeShellRowsForSubscriber, loadSubscriberShellSnapshot } from "./ShellStream.ts";
import { presentThreadShell } from "../../../../packages/client-runtime/src/state/models.ts";
import {
  resolveThreadWaits,
  threadWaitKey,
  type ResolvedThreadWait,
} from "../../../../packages/client-runtime/src/state/threadWait.ts";

// Slice A of the waiting display (plan r2, WP A1-A4): the SQL and in-memory shell builders agree
// on the new wait targets and the run sender, and nothing a notification reads changes.

const layerTest = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("codex");
const providerInstanceId = modelSelection.instanceId;

type RunStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";

/** Events for a handful of threads, plus reads of every shell builder for one thread. */
const makeHarness = Effect.fnUntraced(function* (prefix: string) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const at = DateTime.makeUnsafe("2026-11-22T10:00:00.000Z");
  const id = (name: string) => ThreadId.make(`thread:${prefix}:${name}`);
  const runId = (name: string, ordinal: number) => RunId.make(`run:${prefix}:${name}:${ordinal}`);
  const messageId = (name: string, ordinal: number) =>
    MessageId.make(`message:${prefix}:${name}:${ordinal}`);
  let sequence = 0;
  const nextEvent = () => EventId.make(`event:${prefix}:${sequence++}`);
  const createThread = (
    name: string,
    parent: string | null = null,
    overrides: Record<string, unknown> = {},
  ) =>
    store.apply({
      id: nextEvent(),
      type: "thread.created",
      threadId: id(name),
      occurredAt: at,
      payload: {
        createdBy: "user",
        creationSource: parent === null ? "web" : "mcp",
        id: id(name),
        projectId: ProjectId.make(`project:${prefix}`),
        title: name,
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: parent === null ? null : id(parent),
          relationshipToParent: parent === null ? null : "subagent",
          rootThreadId: id(parent ?? name),
        },
        forkedFrom: null,
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
        ...overrides,
      } as never,
    });
  const runOf = (
    name: string,
    ordinal: number,
    status: RunStatus,
    extra: Record<string, unknown> = {},
  ) => ({
    id: runId(name, ordinal),
    threadId: id(name),
    ordinal,
    providerInstanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: messageId(name, ordinal),
    rootNodeId: NodeId.make(`node:${prefix}:${name}:${ordinal}`),
    activeAttemptId: null,
    status,
    requestedAt: at,
    startedAt: at,
    completedAt: status === "running" ? null : at,
    checkpointId: null,
    contextHandoffId: null,
    ...extra,
  });
  const startRun = (name: string, ordinal: number, extra: Record<string, unknown> = {}) =>
    store.apply({
      id: nextEvent(),
      type: "run.created",
      threadId: id(name),
      occurredAt: at,
      payload: runOf(name, ordinal, "running", extra) as never,
    });
  const endRun = (
    name: string,
    ordinal: number,
    status: Exclude<RunStatus, "running">,
    extra: Record<string, unknown> = {},
  ) =>
    store.apply({
      id: nextEvent(),
      type: "run.updated",
      threadId: id(name),
      occurredAt: at,
      payload: runOf(name, ordinal, status, extra) as never,
    });
  /** The message that starts run `ordinal` (its `userMessageId`), or a steer into that run. */
  const message = (
    name: string,
    ordinal: number,
    fields: {
      readonly senderThreadId?: ThreadId;
      readonly linkedSender?: { environmentId: EnvironmentId; threadId: ThreadId; title: string };
      readonly createdBy?: "user" | "agent";
      readonly id?: MessageId;
    } = {},
  ) =>
    store.apply({
      id: nextEvent(),
      type: "message.updated",
      threadId: id(name),
      occurredAt: at,
      payload: {
        id: fields.id ?? messageId(name, ordinal),
        threadId: id(name),
        runId: runId(name, ordinal),
        nodeId: null,
        role: "user",
        text: `message ${ordinal}`,
        attachments: [],
        streaming: false,
        ...(() => {
          const createdBy =
            fields.createdBy ?? (fields.senderThreadId === undefined ? "user" : "agent");
          return { createdBy, creationSource: createdBy === "user" ? "web" : "mcp" };
        })(),
        ...(fields.senderThreadId === undefined ? {} : { senderThreadId: fields.senderThreadId }),
        ...(fields.linkedSender === undefined ? {} : { linkedSender: fields.linkedSender }),
        createdAt: at,
        updatedAt: at,
      } as never,
    });
  const putItem = (payload: OrchestrationV2TurnItem) =>
    store.apply({
      id: nextEvent(),
      type: "turn-item.updated",
      threadId: payload.threadId,
      runId: payload.runId ?? undefined,
      driver,
      occurredAt: at,
      payload,
    });
  const session = (name: string, status: "ready" | "stopped" | "error") => ({
    id: ProviderSessionId.make(`session:${prefix}:${name}`),
    driver,
    providerInstanceId,
    status,
    cwd: "/workspace",
    model: modelSelection.model,
    capabilities: CodexProviderCapabilitiesV2,
    createdAt: at,
    updatedAt: at,
    lastError: null,
  });
  const attachSession = (name: string) =>
    store.apply({
      id: nextEvent(),
      type: "provider-session.attached",
      threadId: id(name),
      driver,
      providerInstanceId,
      occurredAt: at,
      payload: session(name, "ready"),
    });
  const setSession = (name: string, status: "ready" | "stopped" | "error") =>
    store.apply({
      id: nextEvent(),
      type: "provider-session.updated",
      threadId: id(name),
      occurredAt: at,
      payload: session(name, status),
    });
  const setRoster = (
    name: string,
    pendingBackgroundTasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
  ) =>
    store.apply({
      id: nextEvent(),
      type: "provider-thread.updated",
      threadId: id(name),
      driver,
      providerInstanceId,
      occurredAt: at,
      payload: {
        id: ProviderThreadId.make(`provider-thread:${prefix}:${name}`),
        driver,
        providerInstanceId,
        providerSessionId: ProviderSessionId.make(`session:${prefix}:${name}`),
        appThreadId: id(name),
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle" as const,
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [...pendingBackgroundTasks],
        createdAt: at,
        updatedAt: at,
      },
    });
  /** Every shell builder's view of one thread: in memory, single SQL read, SQL snapshot. */
  const shells = Effect.fnUntraced(function* (name: string) {
    const memory = ProjectionStore.threadShellFromProjection(
      yield* store.getThreadProjection(id(name)),
    );
    const single = yield* store.getThreadShell(id(name));
    const snapshot = yield* store.getShellSnapshot();
    const listed =
      [...snapshot.threads, ...snapshot.archivedThreads].find((thread) => thread.id === id(name)) ??
      null;
    return { memory, single, listed };
  });
  /** Asserts every builder gives `pick(shell)` equal to `expected`. */
  const assertShells = Effect.fnUntraced(function* <A>(
    name: string,
    pick: (shell: OrchestrationV2ThreadShell) => A,
    expected: A,
  ) {
    const { memory, single, listed } = yield* shells(name);
    assert.deepEqual(pick(memory), expected, `${name} memory`);
    assert.isNotNull(single, `${name} getThreadShell`);
    assert.deepEqual(pick(single!), expected, `${name} getThreadShell`);
    assert.isNotNull(listed, `${name} snapshot`);
    assert.deepEqual(pick(listed!), expected, `${name} snapshot`);
  });
  return {
    store,
    at,
    id,
    runId,
    messageId,
    createThread,
    startRun,
    endRun,
    message,
    putItem,
    attachSession,
    setSession,
    setRoster,
    shells,
    assertShells,
  };
});

const waitOf = (shell: OrchestrationV2ThreadShell) => ({
  waitingOn: shell.waitingOn,
  waitPhase: shell.waitPhase,
});

/**
 * Every shell field a Web Push notification, an auto-wait or Home's server section reads
 * (WebPushNotifications.ts publishThread and autoWaitTargetState). Slice A must not move any.
 */
const notificationInputsOf = (shell: OrchestrationV2ThreadShell) => ({
  status: shell.status,
  activityRunStatus: shell.activityRunStatus,
  homeDashboardSection: shell.homeDashboardSection,
  homeNeedsYou: shell.homeNeedsYou,
  homeAskText: shell.homeAskText,
  homeDoneText: shell.homeDoneText,
  homeFirstNextStep: shell.homeFirstNextStep,
  homeAutoWaitActive: shell.homeAutoWaitActive,
  homeHandedOff: shell.homeHandedOff,
  blockedOnThreadWait: shell.blockedOnThreadWait,
  pendingBackgroundTasks: shell.pendingBackgroundTasks,
  settledOverride: shell.settledOverride,
  archivedAt: shell.archivedAt,
  deletedAt: shell.deletedAt,
  snoozedUntil: shell.snoozedUntil,
  latestRunId: shell.latestRunId,
  latestRunHumanAuthored: shell.latestRunHumanAuthored,
});

it.effect("both shell builders wait on an awaited command while its session lives (f700bdf9)", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness("awaited-command");
    yield* h.createThread("owner");
    yield* h.startRun("owner", 1);
    yield* h.message("owner", 1);
    // The command item still runs; its native id is the roster's task id.
    yield* h.putItem({
      id: TurnItemId.make("item:awaited-command:bash"),
      threadId: h.id("owner"),
      runId: h.runId("owner", 1),
      nodeId: NodeId.make("node:awaited-command:owner:1"),
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: { driver, nativeId: "bwngue5o4", strength: "weak" },
      parentItemId: null,
      ordinal: 2,
      status: "running",
      title: null,
      startedAt: h.at,
      completedAt: null,
      updatedAt: h.at,
      type: "command_execution",
      input: "vp test --run apps/server",
    } as never);
    yield* h.endRun("owner", 1, "completed");
    yield* h.attachSession("owner");
    const roster = [
      {
        taskId: "bwngue5o4",
        kind: "command" as const,
        awaited: true as const,
        description: "vp test --run apps/server\n--reporter dot",
      },
    ];
    yield* h.setRoster("owner", roster);
    yield* h.assertShells("owner", waitOf, {
      waitingOn: [
        {
          source: "awaited_child",
          environmentId: null,
          threadId: null,
          title: "vp test --run apps/server",
          taskId: "bwngue5o4",
          itemId: TurnItemId.make("item:awaited-command:bash"),
        },
      ],
      waitPhase: "waiting",
    });
    // Notification inputs are the ones 188a8db5 derives for this shape: a completed run whose
    // awaited command keeps the roster (and so the auto-wait guard) non-empty. Only the in-memory
    // shell sets a Home section; SQL shells leave it to clients, as on the baseline.
    yield* h.assertShells(
      "owner",
      (shell) => ({
        status: shell.status,
        activityRunStatus: shell.activityRunStatus,
        blockedOnThreadWait: shell.blockedOnThreadWait,
        homeNeedsYou: shell.homeNeedsYou ?? false,
        tasks: (shell.pendingBackgroundTasks ?? []).map((task) => task.taskId),
      }),
      {
        status: "completed",
        activityRunStatus: null,
        blockedOnThreadWait: false,
        homeNeedsYou: false,
        tasks: ["bwngue5o4"],
      },
    );
    assert.equal((yield* h.shells("owner")).memory.homeDashboardSection, "done");
    // The session stops: the command died with the provider process.
    for (const status of ["stopped", "error"] as const) {
      yield* h.setSession("owner", status);
      yield* h.assertShells("owner", waitOf, { waitingOn: [], waitPhase: "ended" });
    }
    yield* h.setSession("owner", "ready");
    yield* h.assertShells("owner", (shell) => shell.waitPhase, "waiting");
    // An unawaited command (a dev server) never holds.
    yield* h.setRoster("owner", [{ taskId: "dev-server", kind: "command", description: "vp dev" }]);
    yield* h.assertShells("owner", waitOf, { waitingOn: [], waitPhase: "ended" });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("both shell builders wait on pending PR checks whatever the session does", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness("pr-watch");
    const sql = yield* SqlClient.SqlClient;
    yield* h.createThread("owner");
    yield* h.startRun("owner", 1);
    yield* h.message("owner", 1);
    yield* h.endRun("owner", 1, "completed");
    const link = (
      watch: Record<string, unknown> | undefined,
      state: "open" | "merged" = "open",
    ) => ({
      host: "github.com",
      repository: "owner/repository",
      number: 42,
      url: "https://github.com/owner/repository/pull/42",
      source: "manual",
      linkedAt: "2026-11-22T10:00:00.000Z",
      snapshot: {
        state,
        title: "Ship it",
        headBranch: "feature",
        baseBranch: "main",
        isDraft: false,
        updatedAt: "2026-11-22T10:00:00.000Z",
        syncedAt: "2026-11-22T10:00:00.000Z",
        closedAt: null,
        mergedAt: state === "merged" ? "2026-11-22T10:00:00.000Z" : null,
      },
      stack: null,
      ...(watch === undefined
        ? {}
        : {
            watch: {
              startedAt: "2026-11-22T10:00:00.000Z",
              headSha: null,
              failedChecks: [],
              passed: false,
              passedChecks: [],
              remarksThrough: "2026-11-22T10:00:00.000Z",
              remarkIds: [],
              conflicting: false,
              wakes: 0,
              ...watch,
            },
          }),
    });
    const setLinks = (links: ReadonlyArray<unknown>) =>
      sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.pullRequests', json(${JSON.stringify(links)}))
        WHERE thread_id = ${h.id("owner")}`;
    const prTarget = {
      source: "awaited_child" as const,
      environmentId: null,
      threadId: null,
      title: "PR #42 checks",
      taskId: "pull-request-watch:github.com/owner/repository#42",
    };
    // No provider session at all, then stopped and error: the watch is the server's own.
    for (const watch of [{ checksPending: true }, {}]) {
      yield* setLinks([link(watch)]);
      yield* h.assertShells("owner", waitOf, { waitingOn: [prTarget], waitPhase: "waiting" });
    }
    yield* h.attachSession("owner");
    for (const status of ["stopped", "error"] as const) {
      yield* h.setSession("owner", status);
      yield* h.assertShells("owner", waitOf, { waitingOn: [prTarget], waitPhase: "waiting" });
    }
    // Notification inputs stay the baseline's: the watch holds the roster, the section is done.
    assert.equal((yield* h.shells("owner")).memory.homeDashboardSection, "done");
    yield* h.assertShells(
      "owner",
      (shell) => (shell.pendingBackgroundTasks ?? []).map((task) => [task.taskId, task.awaited]),
      [[prTarget.taskId, true]],
    );
    // Checks complete, merged, unwatched, removed: nothing holds.
    for (const links of [
      [link({ checksPending: false })],
      [link({ checksPending: true }, "merged")],
      [link(undefined)],
      [],
    ]) {
      yield* setLinks(links);
      yield* h.assertShells("owner", waitOf, { waitingOn: [], waitPhase: "ended" });
    }
    // Settled, archived or failed: a pending watch never resurrects Waiting.
    yield* setLinks([link({ checksPending: true })]);
    yield* sql`UPDATE orchestration_v2_projection_threads
      SET payload_json = json_set(payload_json, '$.settledOverride', 'settled')
      WHERE thread_id = ${h.id("owner")}`;
    yield* h.assertShells("owner", (shell) => shell.waitPhase, "ended");
    yield* sql`UPDATE orchestration_v2_projection_threads
      SET payload_json = json_set(payload_json, '$.settledOverride', NULL)
      WHERE thread_id = ${h.id("owner")}`;
    yield* h.startRun("owner", 2);
    yield* h.message("owner", 2);
    yield* h.endRun("owner", 2, "failed");
    yield* h.assertShells("owner", (shell) => shell.waitPhase, "ended");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("both shell builders name the thread whose message started the latest run (WP A3)", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness("sender");
    yield* h.createThread("parent");
    yield* h.createThread("sender");
    yield* h.createThread("steerer");
    yield* h.createThread("child", "parent");
    const senderOf = (shell: OrchestrationV2ThreadShell) => shell.latestRunSenderThreadId;

    // S's t3_thread_send starts the child's run 1.
    yield* h.startRun("child", 1);
    yield* h.message("child", 1, { senderThreadId: h.id("sender") });
    yield* h.assertShells("child", senderOf, h.id("sender"));
    // A steer from another thread lands in the same run and starts nothing.
    yield* h.message("child", 1, {
      id: MessageId.make("message:sender:child:steer"),
      senderThreadId: h.id("steerer"),
    });
    yield* h.assertShells("child", senderOf, h.id("sender"));
    yield* h.endRun("child", 1, "completed");
    yield* h.assertShells("child", senderOf, h.id("sender"));

    // An automatic usage-limit resume and a hook continuation keep the original sender.
    yield* h.startRun("child", 2, { usageLimitContinuationOfRunId: h.runId("child", 1) });
    yield* h.message("child", 2, { createdBy: "agent" });
    yield* h.assertShells("child", senderOf, h.id("sender"));
    yield* h.endRun("child", 2, "completed", {
      usageLimitContinuationOfRunId: h.runId("child", 1),
    });
    yield* h.startRun("child", 3, { hookContinuationOfRunId: h.runId("child", 2) });
    yield* h.message("child", 3, { createdBy: "agent" });
    yield* h.assertShells("child", senderOf, h.id("sender"));
    yield* h.endRun("child", 3, "completed", { hookContinuationOfRunId: h.runId("child", 2) });

    // A user send resets it.
    yield* h.startRun("child", 4);
    yield* h.message("child", 4);
    yield* h.assertShells("child", senderOf, null);
    yield* h.endRun("child", 4, "completed");

    // A linked-environment sender is out of scope: null.
    yield* h.startRun("child", 5);
    yield* h.message("child", 5, {
      senderThreadId: h.id("sender"),
      linkedSender: {
        environmentId: EnvironmentId.make("env-remote"),
        threadId: ThreadId.make("remote-thread"),
        title: "Remote",
      },
    });
    yield* h.assertShells("child", senderOf, null);
    yield* h.endRun("child", 5, "completed");

    // The parent sending gives the parent; threads with no runs say null.
    yield* h.startRun("child", 6);
    yield* h.message("child", 6, { senderThreadId: h.id("parent") });
    yield* h.assertShells("child", senderOf, h.id("parent"));
    yield* h.assertShells("sender", senderOf, null);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("the sender field moves nothing a sender, a parent or a notification reads", () =>
  Effect.gen(function* () {
    // Two identical families; only the message that starts the child's run differs: one has a
    // sender (the new path), the other none (the baseline path). Every other field must agree.
    const scenario = Effect.fnUntraced(function* (prefix: string, withSender: boolean) {
      const h = yield* makeHarness(prefix);
      yield* h.createThread("parent");
      yield* h.createThread("sender");
      yield* h.createThread("child", "parent");
      for (const name of ["parent", "sender"]) {
        yield* h.startRun(name, 1);
        yield* h.message(name, 1);
        yield* h.endRun(name, 1, "completed");
      }
      yield* h.startRun("child", 1);
      // Both agent-authored, so the sender is the only difference.
      yield* h.message(
        "child",
        1,
        withSender ? { senderThreadId: h.id("sender") } : { createdBy: "agent" },
      );
      const running = {
        parent: (yield* h.shells("parent")).single!,
        sender: (yield* h.shells("sender")).single!,
        child: (yield* h.shells("child")).single!,
      };
      yield* h.endRun("child", 1, "completed");
      const done = {
        parent: (yield* h.shells("parent")).single!,
        sender: (yield* h.shells("sender")).single!,
        child: (yield* h.shells("child")).single!,
      };
      return { running, done };
    });
    /** The shell as JSON with the scenario's id prefix and the new field taken out. */
    const normalized = (value: object, prefix: string) => {
      const { latestRunSenderThreadId: _sender, ...fields } =
        value as Partial<OrchestrationV2ThreadShell>;
      return JSON.parse(JSON.stringify(fields).replaceAll(prefix, "side-effect")) as unknown;
    };
    const next = yield* scenario("side-effect-new", true);
    const base = yield* scenario("side-effect-base", false);
    for (const phase of ["running", "done"] as const) {
      for (const name of ["parent", "sender", "child"] as const) {
        // Every shell field, the wait fields and every notification input included.
        assert.deepEqual(
          normalized(next[phase][name], "side-effect-new"),
          normalized(base[phase][name], "side-effect-base"),
          `${phase} ${name} shell`,
        );
        assert.deepEqual(
          normalized(notificationInputsOf(next[phase][name]), "side-effect-new"),
          normalized(notificationInputsOf(base[phase][name]), "side-effect-base"),
          `${phase} ${name} notification inputs`,
        );
      }
    }
    assert.equal(next.running.child.latestRunSenderThreadId, "thread:side-effect-new:sender");
    assert.equal(base.running.child.latestRunSenderThreadId, null);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("the sender lookup searches the messages primary key and adds no scan", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness("sender-plan");
    const sql = yield* SqlClient.SqlClient;
    yield* h.createThread("sender");
    yield* h.createThread("child", "sender");
    yield* h.startRun("child", 1);
    yield* h.message("child", 1, { senderThreadId: h.id("sender") });
    const statements: Array<ReturnType<Statement.Statement<unknown>["compile"]>> = [];
    const observe: Statement.Transformer = (statement) => {
      const compiled = statement.compile();
      if (/(latest|open)_run_sender_thread_id/u.test(compiled[0])) statements.push(compiled);
      return Effect.succeed(statement);
    };
    yield* h.store
      .getThreadShell(h.id("child"))
      .pipe(Effect.provideService(Statement.CurrentTransformer, observe));
    yield* h.store
      .getShellSnapshot()
      .pipe(Effect.provideService(Statement.CurrentTransformer, observe));
    // The trims' index reads the same walk for live subagents.
    yield* h.store
      .listActiveShellIndex()
      .pipe(Effect.provideService(Statement.CurrentTransformer, observe));
    assert.isAbove(statements.length, 0, "a shell read selects the sender");
    assert.isTrue(
      statements.some(([query]) => query.includes("open_run_sender_thread_id")),
      "the shell index selects the sender",
    );
    for (const [query, params] of statements) {
      const details = (yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${query}`,
        params,
      )).map((row) => row.detail);
      assert.isTrue(
        details.some((detail) => /^SEARCH sender_message .*\(message_id=\?\)/u.test(detail)),
        details.join("\n"),
      );
      assert.isFalse(
        details.some((detail) => /^SCAN (sender_message|parent)\b/u.test(detail)),
        details.join("\n"),
      );
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "a trimmed subscriber snapshot resolves every kept thread's wait like the full one (WP A2)",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness("trim");
      const sql = yield* SqlClient.SqlClient;
      const environmentId = EnvironmentId.make("env-trim");
      const settledAt = (minutes: number) => DateTime.add(h.at, { minutes: -minutes });
      const finish = Effect.fnUntraced(function* (name: string) {
        yield* h.startRun(name, 1);
        yield* h.message(name, 1);
        yield* h.endRun(name, 1, "completed");
      });
      const busy = Effect.fnUntraced(function* (name: string, sender?: string) {
        yield* h.startRun(name, 1);
        yield* h.message(name, 1, sender === undefined ? {} : { senderThreadId: h.id(sender) });
      });

      // P completed with live, idle and nested children; S sent to one of them.
      yield* h.createThread("p");
      yield* finish("p");
      yield* h.createThread("c-live", "p");
      yield* busy("c-live");
      yield* h.createThread("c-idle", "p");
      yield* finish("c-idle");
      yield* h.createThread("c-mid", "p");
      yield* finish("c-mid");
      yield* h.createThread("g", "c-mid");
      yield* busy("g");
      yield* h.createThread("s");
      yield* finish("s");
      yield* h.createThread("k", "p");
      yield* busy("k", "s");
      // Thirty settled top-level threads, so the older-settled trim drops the oldest; the oldest
      // is also the parent of a live child and the sender of another one.
      for (let index = 0; index < 30; index++) {
        yield* h.createThread(`old-${index}`, null, {
          settledOverride: "settled",
          settledAt: settledAt(60 + index),
        });
        yield* finish(`old-${index}`);
      }
      yield* h.createThread("old-child", "old-29");
      yield* busy("old-child");
      yield* h.createThread("k2", "p");
      yield* busy("k2", "old-28");

      const full = yield* h.store.getShellSnapshot();
      const trimmed = (yield* loadSubscriberShellSnapshot({
        sql,
        listShellIndex: h.store.listActiveShellIndex(),
        readThreads: (threadIds) =>
          h.store.readShellSnapshot({
            location: "active",
            ...(threadIds === undefined ? {} : { threadIds }),
          }),
        listProjects: Effect.succeed([]),
        latestSequence: Effect.succeed(0),
        options: { omitIdleSubagents: true, omitOlderSettled: true },
      })).snapshot;
      const resolve = (threads: ReadonlyArray<OrchestrationV2ThreadShell>) =>
        resolveThreadWaits({
          threads: threads.map((thread) => presentThreadShell(environmentId, thread)),
          environmentReady: () => true,
        });
      const fullWaits = resolve(full.threads);
      const trimmedWaits = resolve(trimmed.threads);
      const summary = (wait: ResolvedThreadWait | undefined) =>
        wait === undefined
          ? null
          : {
              waiting: wait.waiting,
              open: wait.targets
                .filter((target) => target.state !== "ended")
                .map((target) => `${target.threadId ?? target.taskId}:${target.state}`)
                .toSorted(),
            };
      const waitOfThread = (waits: typeof fullWaits, name: string) =>
        summary(waits.get(threadWaitKey(environmentId, h.id(name))));

      // The trims really trimmed: the idle child and the older settled threads are gone.
      const keptIds = new Set(trimmed.threads.map((thread) => thread.id));
      assert.isFalse(keptIds.has(h.id("c-idle")));
      assert.isFalse(keptIds.has(h.id("old-28")));
      assert.isTrue(keptIds.has(h.id("old-29")), "the parent of a live child stays");
      // Positive state on both sides, not a vacuous equality.
      for (const waits of [fullWaits, trimmedWaits]) {
        assert.deepEqual(waitOfThread(waits, "p"), {
          waiting: true,
          open: [`${h.id("c-live")}:live`, `${h.id("c-mid")}:live`].toSorted(),
        });
        assert.deepEqual(waitOfThread(waits, "c-mid"), {
          waiting: true,
          open: [`${h.id("g")}:live`],
        });
        assert.deepEqual(waitOfThread(waits, "s"), {
          waiting: true,
          open: [`${h.id("k")}:live`],
        });
        assert.isFalse(waitOfThread(waits, "old-29")?.waiting, "a settled parent stays ended");
      }
      // A sender trimmed away takes its child with it: the parent never takes the run back.
      assert.isFalse(waitOfThread(fullWaits, "old-28")?.waiting);
      for (const thread of trimmed.threads) {
        const name = thread.id.slice("thread:trim:".length);
        assert.deepEqual(waitOfThread(trimmedWaits, name), waitOfThread(fullWaits, name), name);
      }

      // Reconnect: live -> disconnected (unknown, still waiting) -> synchronized with C ended.
      const disconnected = resolveThreadWaits({
        threads: trimmed.threads.map((thread) => presentThreadShell(environmentId, thread)),
        environmentReady: () => false,
      }).get(threadWaitKey(environmentId, h.id("s")));
      assert.isTrue(disconnected?.waiting);
      assert.isTrue(disconnected?.targets.every((target) => target.state === "unknown"));
      yield* h.endRun("k", 1, "completed");
      const after = (yield* h.store.getShellSnapshot()).threads;
      assert.isFalse(
        resolve(after).get(threadWaitKey(environmentId, h.id("s")))?.waiting,
        "the sender clears once its run ended",
      );
      assert.notInclude(
        (resolve(after).get(threadWaitKey(environmentId, h.id("p")))?.targets ?? []).map(
          (target) => target.threadId,
        ),
        h.id("k"),
        "and the parent does not take it back",
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "a trimmed snapshot keeps a completed subagent sender while the sibling run it started is live",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness("sibling");
      const sql = yield* SqlClient.SqlClient;
      const environmentId = EnvironmentId.make("env-sibling");
      const finish = Effect.fnUntraced(function* (name: string, ordinal = 1) {
        yield* h.startRun(name, ordinal);
        yield* h.message(name, ordinal);
        yield* h.endRun(name, ordinal, "completed");
      });
      /** A fresh subscriber snapshot, as on reconnect: Home, no thread family mounted. */
      const subscribe = (options: { omitIdleSubagents: boolean; omitOlderSettled: boolean }) =>
        loadSubscriberShellSnapshot({
          sql,
          listShellIndex: h.store.listActiveShellIndex(),
          readThreads: (threadIds) =>
            h.store.readShellSnapshot({
              location: "active",
              ...(threadIds === undefined ? {} : { threadIds }),
            }),
          listProjects: Effect.succeed([]),
          latestSequence: Effect.succeed(0),
          options,
        }).pipe(Effect.map((loaded) => loaded.snapshot.threads));
      const resolve = (threads: ReadonlyArray<OrchestrationV2ThreadShell>, ready = true) =>
        resolveThreadWaits({
          threads: threads.map((thread) => presentThreadShell(environmentId, thread)),
          environmentReady: () => ready,
        });
      const summary = (waits: ReturnType<typeof resolve>, name: string) => {
        const wait = waits.get(threadWaitKey(environmentId, h.id(name)));
        return wait === undefined
          ? null
          : {
              waiting: wait.waiting,
              open: wait.targets
                .filter((target) => target.state !== "ended")
                .map((target) => `${target.threadId ?? target.taskId}:${target.state}`)
                .toSorted(),
            };
      };
      const snapshots = Effect.gen(function* () {
        const full = (yield* h.store.getShellSnapshot()).threads;
        return {
          full,
          indexed: yield* subscribe({ omitIdleSubagents: true, omitOlderSettled: true }),
          indexedIdleOnly: yield* subscribe({ omitIdleSubagents: true, omitOlderSettled: false }),
          inMemory: activeShellRowsForSubscriber(full, true).threads,
        };
      });

      // P finished. S and C are P's subagents; C went idle earlier. S's t3_thread_send resumes C
      // (no tracking task under S), then S completes with nothing of its own left.
      yield* h.createThread("p");
      yield* finish("p");
      yield* h.createThread("s", "p");
      yield* h.createThread("c", "p");
      yield* h.createThread("idle", "p");
      yield* finish("idle");
      yield* finish("c");
      yield* h.startRun("s", 1);
      yield* h.message("s", 1, { senderThreadId: h.id("p") });
      yield* h.startRun("c", 2);
      yield* h.message("c", 2, { senderThreadId: h.id("s") });
      yield* h.endRun("s", 1, "completed");

      const index = yield* h.store.listActiveShellIndex();
      assert.equal(
        index.find((entry) => entry.id === h.id("c"))?.openRunSenderThreadId,
        h.id("s"),
        "the index names the sender of C's open run",
      );
      assert.isNull(index.find((entry) => entry.id === h.id("idle"))?.openRunSenderThreadId);

      const live = yield* snapshots;
      const fullWaits = resolve(live.full);
      assert.deepEqual(summary(fullWaits, "s"), { waiting: true, open: [`${h.id("c")}:live`] });
      assert.deepEqual(summary(fullWaits, "p"), {
        waiting: true,
        open: [`${h.id("s")}:live`],
      });
      for (const [name, threads] of [
        ["indexed", live.indexed],
        ["indexed idle-only", live.indexedIdleOnly],
        ["in-memory", live.inMemory],
      ] as const) {
        // P first: on the old trim it resolved not-waiting (Done) while C ran.
        const waits = resolve(threads);
        for (const thread of ["p", "s", "c"]) {
          assert.deepEqual(summary(waits, thread), summary(fullWaits, thread), `${name} ${thread}`);
        }
        const ids = new Set(threads.map((thread) => thread.id));
        assert.isTrue(ids.has(h.id("s")), `${name}: the completed sender S stays`);
        assert.isFalse(ids.has(h.id("idle")), `${name}: the idle sibling is still trimmed`);
      }

      // Reconnect: disconnected keeps P waiting (unknown), a fresh trimmed snapshot restores it.
      assert.isTrue(
        resolve(live.indexed, false).get(threadWaitKey(environmentId, h.id("p")))?.waiting,
      );
      const reconnected = resolve(
        yield* subscribe({ omitIdleSubagents: true, omitOlderSettled: true }),
      );
      assert.deepEqual(summary(reconnected, "p"), summary(fullWaits, "p"), "reconnected P");
      assert.deepEqual(summary(reconnected, "s"), summary(fullWaits, "s"), "reconnected S");

      // C completes: P and S clear in full and trimmed snapshots, and the idle S is trimmed again.
      yield* h.endRun("c", 2, "completed");
      const done = yield* snapshots;
      for (const [name, threads] of [
        ["full", done.full],
        ["indexed", done.indexed],
        ["indexed idle-only", done.indexedIdleOnly],
        ["in-memory", done.inMemory],
      ] as const) {
        const waits = resolve(threads);
        assert.isFalse(summary(waits, "p")?.waiting ?? false, `${name}: P clears`);
        assert.isFalse(summary(waits, "s")?.waiting ?? false, `${name}: S clears`);
      }
      assert.notInclude(
        done.indexed.map((thread) => thread.id),
        h.id("s"),
        "an idle sender with no open run is trimmed",
      );
    }).pipe(Effect.provide(layerTest)),
);
