import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as AssetSigner from "../../../assets/AssetSigner.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as DocumentText from "../../../provider/DocumentText.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { idleThreadProjection, liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as AttachmentHandlers from "./handlers.ts";
import { AttachmentToolkit } from "./tools.ts";

const sender = ThreadId.make("thread:attachment-sender");
const target = ThreadId.make("thread:attachment-target");
const attachment = {
  type: "file",
  id: "attachment-target-1",
  name: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 5,
};

it.effect("holds an attachment send to an idle thread unless it is urgent with a reason", () =>
  Effect.gen(function* () {
    const sends: Array<ThreadManagement.ThreadManagementSendInput> = [];
    const dependencies = Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment:attachment-send"),
        requestNamespace: "provider:attachment-send",
        thread: {
          threadId: sender,
          providerSessionId: "provider:attachment-send",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
        getProjectThreadRecords: () =>
          Effect.succeed({
            ...idleThreadProjection(liveThreadShell(target, { activeRunId: null })),
            messages: [{ attachments: [attachment] }],
          } as never),
        // The service holds whatever is not urgent; the handler only passes the reason through.
        sendToThread: (input) =>
          Effect.sync(() => {
            sends.push(input);
            return {
              run: { id: RunId.make("run:attachment-send"), status: "queued" },
              message: { attachments: input.attachments },
              held: input.urgentReason === undefined,
            } as never;
          }),
      }),
      Layer.mock(AssetSigner.AssetSigner)({}),
      Layer.mock(ServerSecretStore.ServerSecretStore)({}),
      Layer.mock(DocumentText.DocumentText)({}),
    ).pipe(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-attachment-send-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    );
    const toolkit = yield* AttachmentToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(AttachmentHandlers.layer).pipe(
          Layer.provide(dependencies),
        ),
      ),
    );
    const send = (params: { readonly [field: string]: string | boolean }) =>
      toolkit
        .handle("t3_thread_send_attachments", {
          threadId: target,
          message: "see attached",
          attachments: [attachment],
          ...params,
        })
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((chunks) => chunks.at(-1)?.result),
          Effect.provide(dependencies),
        );

    expect(yield* send({ urgent: true })).toMatchObject({ code: "invalid_request" });
    expect(sends).toHaveLength(0);
    expect(yield* send({})).toMatchObject({ threadId: target, held: true });
    const urgent = yield* send({ urgent: true, urgentReason: "blocking question" });
    expect(urgent).not.toHaveProperty("held");
    expect(sends.map((input) => [input.senderThreadId, input.urgentReason])).toEqual([
      [sender, undefined],
      [sender, "blocking question"],
    ]);
  }).pipe(Effect.scoped),
);
