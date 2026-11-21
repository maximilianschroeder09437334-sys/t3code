import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  PreviewAutomationNoAvailableHostError,
} from "@t3tools/contracts";
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
import { claimPreviewRecording } from "./handlers.ts";
import * as PreviewHandlers from "./handlers.ts";
import { PreviewStandardToolkit, PreviewSnapshotToolkit } from "./tools.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as HookRegistry from "../../../hooks/HookRegistry.ts";

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
    if (first._tag === "Failure" && blocked._tag === "Failure")
      expect([first.failure._tag, blocked.failure._tag].sort()).toEqual([
        "OrchestratorMcpFailure",
        "PreviewAutomationNoAvailableHostError",
      ]);
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
          Layer.provideMerge(NodeServices.layer),
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
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
  );
});
