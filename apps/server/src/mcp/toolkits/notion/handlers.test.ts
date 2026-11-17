import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as ActivityLedger from "../../../activity/ActivityLedger.ts";
import * as NotionOutbox from "../../../activity/NotionOutbox.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { NotionOutboxToolkit } from "./tools.ts";
import * as Handlers from "./handlers.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";

const callerId = ThreadId.make("thread:reporter");
const otherId = ThreadId.make("thread:victim");
const caller = { ...liveThreadShell(callerId), projectId: ProjectId.make("project:reporter") };
const other = { ...liveThreadShell(otherId), projectId: ProjectId.make("project:victim") };
const shells = new Map<ThreadId, OrchestrationV2ThreadShell>([
  [caller.id, caller],
  [other.id, other],
]);
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:work-report"),
  requestNamespace: "work-report-test",
  thread: {
    threadId: caller.id,
    providerSessionId: "work-report-test",
    providerInstanceId: caller.providerInstanceId,
    subagent: false,
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "work-report-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "work-report-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const layer = McpHttpServer.toolkitRegistration(NotionOutboxToolkit, Handlers.layer).pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provideMerge(ActivityLedger.layer),
  Layer.provideMerge(NotionOutbox.layer),
  Layer.provideMerge(
    ServerSettings.ServerSettingsService.layerTest({
      notionSync: {
        token: null,
        projects: {
          [caller.projectId]: { dataSourceId: "source", format: "t3", sharePage: "log" },
          [other.projectId]: { dataSourceId: "source", format: "t3", sharePage: "log" },
        },
      },
    }),
  ),
  Layer.provide(Sqlite.layerMemory),
  Layer.provide(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed(shells.get(id) ?? null),
      getThreadRecords: () => Effect.succeed({ runs: [] } as never),
    }),
  ),
);

const call = (name: string, arguments_: Record<string, unknown>, as: ThreadId = caller.id) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server.callTool({ name, arguments: arguments_ }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        ...scope,
        thread: { ...scope.thread!, threadId: as },
      }),
      Effect.provideService(McpSchema.McpServerClient, mcpClient),
    );
  });
it.layer(layer)("notion outbox tools", (it) => {
  it.effect("requires auxiliary acknowledgement before resuming an uncertain parent create", () =>
    Effect.gen(function* () {
      const ledger = yield* ActivityLedger.ActivityLedger;
      const outbox = yield* NotionOutbox.NotionOutbox;
      const { event } = yield* ledger.append({
        key: "auxiliary",
        kind: "progress",
        projectId: caller.projectId,
        threadId: caller.id,
        summary: "auxiliary",
      });
      yield* outbox.capture(10);
      assert.isTrue(yield* outbox.reserveAux(event.sequence, "source", "week:test"));
      yield* outbox.recover();
      yield* call("t3_notion_outbox_ack", {
        sequence: event.sequence,
        pageId: "parent",
        blockId: "wrong",
      });
      assert.strictEqual((yield* outbox.fallbackForProject(caller.projectId, 10)).length, 1);
      yield* call("t3_notion_outbox_ack", {
        sequence: event.sequence,
        pageId: "parent",
        auxiliary: true,
      });
      assert.strictEqual(yield* outbox.getPage("source", "week:test"), "parent");
    }),
  );
  it.effect("lists and acknowledges only the caller's project", () =>
    Effect.gen(function* () {
      const ledger = yield* ActivityLedger.ActivityLedger;
      const outbox = yield* NotionOutbox.NotionOutbox;
      const own = yield* ledger.append({
        key: "own",
        kind: "progress",
        projectId: caller.projectId,
        threadId: caller.id,
        summary: "own event",
      });
      const theirs = yield* ledger.append({
        key: "theirs",
        kind: "progress",
        projectId: other.projectId,
        threadId: other.id,
        summary: "other event",
      });
      yield* outbox.capture(10);
      yield* outbox.fail(own.event.sequence, 403, 0);
      yield* outbox.fail(theirs.event.sequence, 403, 0);
      assert.isTrue(yield* outbox.beginRollup(caller.projectId, "1970-01-01"));
      yield* outbox.rejectRollup(caller.projectId, "1970-01-01", null, 0, 0);
      const list = yield* call("t3_notion_outbox_list", { limit: 10 });
      assert.isFalse(list.isError);
      assert.include(JSON.stringify(list), "own event");
      assert.notInclude(JSON.stringify(list), "other event");
      assert.include(JSON.stringify(list), "1970-01-01");
      const invalid = yield* call("t3_notion_outbox_ack", {
        sequence: own.event.sequence,
        day: "1970-01-01",
        pageId: "page",
        blockId: "block",
      });
      assert.isTrue(invalid.isError);
      assert.strictEqual((yield* outbox.fallbackForProject(caller.projectId, 10)).length, 1);
      yield* call("t3_notion_outbox_ack", {
        sequence: theirs.event.sequence,
        pageId: "page",
        blockId: "block",
      });
      assert.strictEqual((yield* outbox.fallbackForProject(other.projectId, 10)).length, 1);
      yield* call("t3_notion_outbox_ack", {
        sequence: own.event.sequence,
        pageId: "page",
        blockId: "block",
      });
      assert.strictEqual((yield* outbox.fallbackForProject(caller.projectId, 10)).length, 0);
      yield* call("t3_notion_outbox_ack", {
        day: "1970-01-01",
        pageId: "daily-page",
        throughSequence: own.event.sequence,
      });
      assert.strictEqual((yield* outbox.rollupsFallback(caller.projectId, 10)).length, 0);
    }),
  );
});
