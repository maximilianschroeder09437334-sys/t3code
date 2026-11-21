import { assert, it } from "@effect/vitest";
import {
  MessageId,
  RunId,
  ThreadId,
  ProviderInstanceId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { continueHookRun } from "./HookContinuation.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

it.effect("dispatches one replay-safe continuation and carries its staged workspace", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("hook-test-thread");
    const sourceRunId = RunId.make("hook-test-run");
    const originalId = MessageId.make("hook-original-message");
    let delivered = false;
    const commands: Parameters<
      ThreadManagementService.ThreadManagementService["Service"]["dispatch"]
    >[0][] = [];
    const projection = {
      runs: [
        {
          id: sourceRunId,
          status: "completed",
          userMessageId: originalId,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" },
        },
      ],
      messages: [{ id: originalId, text: "Please build this." }],
    } as unknown as OrchestrationV2ThreadProjection;
    const layer = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadRecords: (_thread, _fields, filter) =>
        Effect.succeed({
          ...projection,
          messages: filter?.messageIds?.includes(originalId)
            ? projection.messages
            : delivered
              ? [{ id: MessageId.make(`message:hook-continuation:${sourceRunId}`) } as never]
              : [],
        }),
      dispatch: (command) => {
        commands.push(command);
        delivered = true;
        return Effect.succeed({} as never);
      },
    });
    const input = { threadId, sourceRunId, stageWorkspaceRoot: "C:/workspace" };
    yield* continueHookRun(input).pipe(Effect.provide(layer));
    yield* continueHookRun(input).pipe(Effect.provide(layer));
    assert.lengthOf(commands, 1);
    const command = commands[0]!;
    assert.equal(command.type, "message.dispatch");
    if (command.type === "message.dispatch") {
      assert.equal(command.hookContinuationOfRunId, sourceRunId);
      assert.equal(command.hookStageWorkspaceRoot, "C:/workspace");
      assert.equal(command.creationSource, "server");
      assert.equal(command.modelSelection?.model, "gpt-6");
    }
  }),
);

it.effect("does not resume work when the user requested Full Stop", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("hook-stop-thread");
    const sourceRunId = RunId.make("hook-stop-run");
    const originalId = MessageId.make("hook-stop-original");
    let dispatches = 0;
    const projection = {
      runs: [{ id: sourceRunId, status: "completed", userMessageId: originalId }],
      messages: [{ id: originalId, text: "Full Stop: prepare only." }],
    } as unknown as OrchestrationV2ThreadProjection;
    yield* continueHookRun({ threadId, sourceRunId }).pipe(
      Effect.provide(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (_thread, _fields, filter) =>
            Effect.succeed({
              ...projection,
              messages: filter?.messageIds?.includes(originalId) ? projection.messages : [],
            }),
          dispatch: () => {
            dispatches++;
            return Effect.succeed({} as never);
          },
        }),
      ),
    );
    assert.equal(dispatches, 0);
  }),
);

it.effect("stops an automatic continuation chain after three attempts", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("hook-loop-thread");
    const ids = [0, 1, 2, 3].map((index) => RunId.make(`hook-loop-${index}`));
    const projection = {
      messages: [],
      runs: ids.map((id, index) => ({
        id,
        status: "completed",
        userMessageId: MessageId.make(`hook-loop-message-${index}`),
        ...(index === 0 ? {} : { hookContinuationOfRunId: ids[index - 1] }),
      })),
    } as unknown as OrchestrationV2ThreadProjection;
    let dispatches = 0;
    yield* continueHookRun({ threadId, sourceRunId: ids[3]! }).pipe(
      Effect.provide(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed(projection),
          dispatch: () => {
            dispatches++;
            return Effect.succeed({} as never);
          },
        }),
      ),
    );
    assert.equal(dispatches, 0);
  }),
);
