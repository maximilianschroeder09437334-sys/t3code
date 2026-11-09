import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  PreviewAutomationNoAvailableHostError,
  type PreviewAutomationRequest,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import {
  createPendingAttachmentId,
  parseThreadSegmentFromAttachmentId,
} from "../../../attachmentStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { claimPreviewRecording, layerStandard } from "./handlers.ts";
import * as PreviewHandlers from "./handlers.ts";
import { PreviewStandardToolkit, PreviewSnapshotToolkit } from "./tools.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as HookRegistry from "../../../hooks/HookRegistry.ts";

it.effect("preview_open navigates the opened tab to a dev server in one tool call", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const connected = yield* Deferred.make<void>();
      const tabId = PreviewTabId.make("opened-tab");
      const target = {
        kind: "environment-port" as const,
        port: 3000,
        path: "/settings?tab=account",
      };
      const requests: PreviewAutomationRequest[] = [];
      const status = {
        available: true,
        visible: false,
        tabId,
        url: "http://localhost:3000/settings?tab=account",
        title: "Settings",
        loading: false,
      };
      const events = yield* broker.connect({
        clientId: "client-1",
        environmentId: scope.environmentId,
      });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Deferred.succeed(connected, undefined);
        requests.push(event.request);
        return broker.respond({
          clientId: "client-1",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result: event.request.operation === "open" ? { ...status, url: "about:blank" } : status,
        });
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(connected);
      const toolkit = yield* PreviewStandardToolkit.pipe(
        Effect.provide(McpToolAccess.HandlersLayer.layer(layerStandard)),
      );
      const results = yield* toolkit
        .handle("preview_open", {
          url: "http://localhost:3000",
          target,
          open: false,
          reuseExistingTab: false,
        })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(results.at(-1)?.result).toEqual(status);
      expect(requests.map(({ operation, input }) => ({ operation, input }))).toEqual([
        { operation: "open", input: { open: false, show: false, reuseExistingTab: false } },
        { operation: "navigate", input: { target } },
      ]);
      expect(requests[1]?.tabId).toBe(tabId);
      expect(requests[1]?.tabIdExplicit).toBe(true);
    }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment-1"),
        requestNamespace: "provider-session-1",
        thread: {
          threadId: ThreadId.make("thread-1"),
          providerSessionId: "provider-session-1",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["preview"] as const),
        issuedAt: 1,
      }),
      Effect.provide(
        Layer.mergeAll(
          PreviewAutomationBroker.layer,
          liveThreadsLayer,
          Layer.mock(HookRegistry.HookRegistry)({
            runEvent: () => Effect.succeed({ allowed: true, messages: [] }),
          }),
        ).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
      ),
    ),
  ),
);

it.effect("blocks a browser retry until status and snapshot have been inspected", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("browser-recovery-integration");
    const environmentId = EnvironmentId.make("browser-recovery-env");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const scope: McpInvocationContext.McpInvocationScope = {
      environmentId,
      requestNamespace: "browser-recovery",
      thread: { threadId, providerSessionId: "browser-recovery", providerInstanceId },
      client: undefined,
      capabilities: new Set(["preview"]),
      issuedAt: 0,
    };
    const status = {
      available: true,
      visible: true,
      tabId: null,
      url: null,
      title: null,
      loading: false,
    };
    const snapshot = {
      url: "https://example.com",
      title: "Example",
      loading: false,
      visibleText: "",
      interactiveElements: [],
      accessibilityTree: {},
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
      screenshot: { mimeType: "image/png" as const, data: "", width: 1, height: 1 },
    };
    let clicks = 0;
    const dependencies = Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(McpToolAccessTestkit.liveThreadShell(id)),
        getThreadRecords: () =>
          Effect.succeed({ thread: { projectId: ProjectId.make("browser-project") } } as never),
      }),
      Layer.mock(HookRegistry.HookRegistry)({
        runEvent: (input) => {
          const payload = input.payload as {
            recoveryRequired: boolean;
            statusChecked: boolean;
            snapshotChecked: boolean;
          };
          return Effect.succeed(
            payload.recoveryRequired && !(payload.statusChecked && payload.snapshotChecked)
              ? { allowed: false, messages: ["Inspect browser status and snapshot first."] }
              : { allowed: true, messages: [] },
          );
        },
      }),
      Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({
        invoke: (request) => {
          if (request.operation === "click" && ++clicks === 1)
            return Effect.fail(
              new PreviewAutomationNoAvailableHostError({
                operation: "click",
                environmentId,
                threadId,
                providerSessionId: "browser-recovery",
                providerInstanceId,
              }),
            );
          return Effect.succeed(
            (request.operation === "status"
              ? status
              : request.operation === "snapshot"
                ? snapshot
                : {}) as never,
          );
        },
      }),
    );
    const standard = yield* PreviewStandardToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(PreviewHandlers.layerStandard).pipe(
          Layer.provide(dependencies),
        ),
      ),
    );
    const snapshots = yield* PreviewSnapshotToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(PreviewHandlers.layerSnapshot).pipe(
          Layer.provide(dependencies),
        ),
      ),
    );
    const act = () =>
      standard
        .handle("preview_act", { action: "click", locator: "aria-ref=1" })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    const [first, blocked] = yield* Effect.all(
      [act().pipe(Effect.result), act().pipe(Effect.result)],
      { concurrency: "unbounded" },
    );
    expect(first._tag).toBe("Failure");
    expect(blocked._tag).toBe("Failure");
    if (first._tag === "Failure" && blocked._tag === "Failure") {
      expect([first.failure._tag, blocked.failure._tag].sort()).toEqual([
        "OrchestratorMcpFailure",
        "PreviewAutomationNoAvailableHostError",
      ]);
      const denial = [first.failure, blocked.failure].find(
        (failure) => failure._tag === "OrchestratorMcpFailure",
      );
      expect(denial?.message).toContain("Inspect browser status and snapshot first.");
      expect(denial?.message).toContain("Follow the hook rule and relevant AGENTS.md instructions");
      expect(denial?.message).toContain("ask rather than bypassing the hook");
    }
    expect(clicks).toBe(1);
    yield* standard
      .handle("preview_status", {})
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    yield* snapshots
      .handle("preview_snapshot", {})
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    yield* act();
    expect(clicks).toBe(2);
  }),
);

describe("claimPreviewRecording", () => {
  it.effect("overlapping and repeated claims return the same retained recording", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const uploadedAttachmentId = createPendingAttachmentId(".webm");
      const pendingPath = path.join(config.attachmentsDir, `${uploadedAttachmentId}.webm`);
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(pendingPath, "video!");
      const response = {
        id: "desktop-recording",
        tabId: "tab-1",
        path: "/desktop/recording.webm",
        mimeType: "video/webm",
        sizeBytes: 6,
        createdAt: "2026-09-07T00:00:00.000Z",
        uploadedAttachmentId,
      };
      const claim = claimPreviewRecording(ThreadId.make("thread-1"), response);
      const [first, second] = yield* Effect.all([claim, claim], { concurrency: "unbounded" });
      expect(first).toEqual(second);
      expect(yield* claim).toEqual(first);
      expect(yield* fileSystem.readFileString(first.path)).toBe("video!");
      expect(yield* fileSystem.exists(pendingPath)).toBe(false);
      const wrongThread = yield* claimPreviewRecording(ThreadId.make("thread-2"), response).pipe(
        Effect.result,
      );
      expect(wrongThread._tag).toBe("Failure");
      const wrongPath = yield* claimPreviewRecording(ThreadId.make("thread-1"), {
        ...response,
        uploadedAttachmentId: `../${uploadedAttachmentId}`,
      }).pipe(Effect.result);
      expect(wrongPath._tag).toBe("Failure");
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-recording-" }).pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );

  it.effect.each([6, 5])(
    "claims only a complete uploaded recording (reported bytes: %s)",
    (sizeBytes) =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const uploadedAttachmentId = createPendingAttachmentId(".webm");
        const pendingPath = path.join(config.attachmentsDir, `${uploadedAttachmentId}.webm`);
        yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
        yield* fileSystem.writeFileString(pendingPath, "video!");
        const response = {
          id: "desktop-recording",
          tabId: "tab-1",
          path: "/desktop/recording.webm",
          mimeType: "video/webm",
          sizeBytes,
          createdAt: "2026-09-07T00:00:00.000Z",
          uploadedAttachmentId,
        };
        const result = yield* claimPreviewRecording(ThreadId.make("thread-1"), response).pipe(
          Effect.result,
        );
        if (sizeBytes === 6) {
          expect(result._tag).toBe("Success");
          if (result._tag !== "Success") return;
          expect(result.success.path).not.toBe(response.path);
          expect(parseThreadSegmentFromAttachmentId(result.success.id)).toBe("thread-1");
          expect(yield* fileSystem.readFileString(result.success.path)).toBe("video!");
          expect(yield* fileSystem.exists(pendingPath)).toBe(false);
        } else {
          expect(result._tag).toBe("Failure");
          if (result._tag !== "Failure") return;
          expect(result.failure._tag).toBe("PreviewAutomationRecordingTransferError");
          expect(yield* fileSystem.exists(pendingPath)).toBe(true);
        }
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-recording-" }).pipe(
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
      ),
  );
});
