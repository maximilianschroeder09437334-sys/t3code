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

const layer = McpHttpServer.layerActivityToolkit.pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provideMerge(ActivityLedger.layer),
  Layer.provide(Sqlite.layerMemory),
  Layer.provide(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed(shells.get(id) ?? null),
      getThreadRecords: () => Effect.succeed({ runs: [] } as never),
    }),
  ),
);

const call = (arguments_: Record<string, unknown>, as: ThreadId = caller.id) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const thread = { ...scope.thread!, threadId: as };
    return yield* server
      .callTool({ name: "t3_work_report", arguments: arguments_ })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, { ...scope, thread }),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
      );
  });

it.layer(layer)("t3_work_report", (it) => {
  it.effect("files each report for the thread that called, never one named in input", () =>
    Effect.gen(function* () {
      const spoofed = yield* call({
        status: "done",
        summary: "Spoofed",
        threadId: other.id,
        projectId: other.projectId,
      }).pipe(Effect.flip);
      assert.instanceOf(spoofed, McpSchema.InvalidParams);

      assert.isFalse(
        (yield* call({ status: "done", summary: "Landed", commits: ["abc"] })).isError,
      );
      assert.isFalse((yield* call({ status: "blocked", summary: "Stuck" }, other.id)).isError);
      const ledger = yield* ActivityLedger.ActivityLedger;
      const events = yield* ledger.list({ limit: 10 });
      assert.deepStrictEqual(
        events.map((event) => [event.kind, event.threadId, event.projectId, event.links]),
        [
          ["done", caller.id, caller.projectId, { commits: ["abc"] }],
          ["blocked", other.id, other.projectId, undefined],
        ],
      );
    }),
  );

  it.effect.each([
    ["more than three lines", "one\ntwo\nthree\nfour"],
    ["more than 400 characters", "x".repeat(401)],
    ["blank", "   "],
  ])("rejects a summary with %s", ([, summary]) =>
    Effect.gen(function* () {
      const ledger = yield* ActivityLedger.ActivityLedger;
      const before = (yield* ledger.list({ limit: 500 })).length;
      const error = yield* call({ status: "progress", summary }).pipe(Effect.flip);
      assert.instanceOf(error, McpSchema.InvalidParams);
      assert.strictEqual((yield* ledger.list({ limit: 500 })).length, before);
    }),
  );
});
