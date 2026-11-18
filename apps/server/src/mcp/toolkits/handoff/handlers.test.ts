import * as ManagedFolders from "../../../project/ManagedProjectFolders.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Git from "../../../git/GitManager.ts";
import * as Sessions from "../../../orchestration-v2/ProviderSessionManager.ts";
import * as Projects from "../../../orchestration-v2/ProjectStore.ts";
import * as Terminals from "../../../terminal/Manager.ts";
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

import * as EffectOutbox from "../../../orchestration-v2/EffectOutbox.ts";
import * as Option from "effect/Option";
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

const layer = McpHttpServer.layerHandoffToolkit.pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provide(Sqlite.layerMemory),
  Layer.provide(
    Layer.mergeAll(
      NodeCrypto.layer,
      Layer.mock(ManagedFolders.ManagedProjectFolders)({ namedProjectsRoot: "/unused" }),
      Projects.layer,
      Layer.mock(Git.GitManager)({}),
      Layer.mock(Sessions.ProviderSessionManagerV2)({}),
      Layer.mock(Terminals.TerminalManager)({}),
    ),
  ),
  Layer.provide(Sqlite.layerMemory),
  Layer.provide(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed(shells.get(id) ?? null),
      getThreadRecords: (id) =>
        Effect.succeed({
          thread: { ...shells.get(id), branch: "feature", worktreePath: "/workspace" },
          turnItems: [],
        } as never),
    }),
  ),
);

const call = (arguments_: Record<string, unknown>, as: ThreadId = caller.id) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const thread = { ...scope.thread!, threadId: as };
    return yield* server
      .callTool({ name: "t3_handoff_submit", arguments: arguments_ })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, { ...scope, thread }),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
      );
  });

const handoff = {
  goal: "Finish",
  decisions: [],
  state: { branch: "feature", commits: [], verified: [] },
  deadEnds: [],
  next: "Review",
  pointers: [],
};
it.layer(layer)("t3_handoff_submit", (it) => {
  it.effect(
    "review action rejects spoofed and untrusted identities and cannot waive unknown observations",
    () =>
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const invoke = (args: Record<string, unknown>, invocation = scope) =>
          server
            .callTool({ name: "t3_handoff_request_approval", arguments: args })
            .pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
              Effect.provideService(McpSchema.McpServerClient, mcpClient),
            );
        for (const args of [
          { expectedGeneration: "fake", threadId: otherId },
          { expectedGeneration: "fake", decision: "accept" },
          {},
        ])
          assert.instanceOf(yield* invoke(args).pipe(Effect.flip), McpSchema.InvalidParams);
        assert.instanceOf(
          yield* invoke({ expectedGeneration: "fake" }, { ...scope, thread: undefined }).pipe(
            Effect.flip,
          ),
          McpSchema.InvalidParams,
        );
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const before = yield* outbox.get(`core-handoff:${callerId}`);
        const refused = yield* invoke({ expectedGeneration: "fake" });
        assert.isTrue(refused.isError);
        assert.deepEqual(yield* outbox.get(`core-handoff:${callerId}`), before);
        assert.isTrue(Option.isNone(yield* outbox.get(`core-handoff:${otherId}`)));
      }),
  );

  it.effect(
    "accepts only authenticated own-thread handoffs and leaves human tools compatible",
    () =>
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const human = yield* server
          .callTool({ name: "t3_handoff_submit", arguments: handoff })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, {
              ...scope,
              thread: undefined,
            }),
            Effect.provideService(McpSchema.McpServerClient, mcpClient),
            Effect.flip,
          );
        assert.instanceOf(human, McpSchema.InvalidParams);
        const spoofed = yield* call({ ...handoff, threadId: otherId }).pipe(Effect.flip);
        assert.instanceOf(spoofed, McpSchema.InvalidParams);
        assert.isFalse((yield* call(handoff)).isError);
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const own = yield* outbox.get(`core-handoff:${callerId}`);
        assert.isTrue(Option.isSome(own));
        assert.isTrue(Option.isNone(yield* outbox.get(`core-handoff:${otherId}`)));
        const oversize = yield* call({ ...handoff, next: "x".repeat(6001) }).pipe(Effect.flip);
        assert.instanceOf(oversize, McpSchema.InvalidParams);
      }),
  );
  it.effect(
    "readiness rejects spoofed identity and returns unknown evidence without altering a parked request",
    () =>
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const invoke = (args: Record<string, unknown>, invocation = scope) =>
          server
            .callTool({ name: "t3_handoff_readiness", arguments: args })
            .pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
              Effect.provideService(McpSchema.McpServerClient, mcpClient),
            );
        assert.instanceOf(
          yield* invoke({ threadId: otherId }).pipe(Effect.flip),
          McpSchema.InvalidParams,
        );
        assert.instanceOf(
          yield* invoke({}, { ...scope, thread: undefined }).pipe(Effect.flip),
          McpSchema.InvalidParams,
        );
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const before = yield* outbox.get(`core-handoff:${callerId}`);
        const result = yield* invoke({});
        assert.isFalse(result.isError);
        assert.isBelow(Buffer.byteLength(JSON.stringify(result), "utf8"), 16384);
        assert.notProperty(result.structuredContent, "before");
        assert.notProperty(result.structuredContent, "after");
        assert.equal(
          (result.structuredContent as Record<string, unknown>)?.classification,
          "unknown",
        );
        assert.equal(
          (result.structuredContent as Record<string, unknown>)?.transferAuthorized,
          false,
        );
        assert.deepEqual(yield* outbox.get(`core-handoff:${callerId}`), before);
      }),
  );
});
