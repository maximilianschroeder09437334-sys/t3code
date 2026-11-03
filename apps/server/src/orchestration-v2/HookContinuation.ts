import {
  CommandId,
  MessageId,
  type OrchestrationV2Run,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { userRequestedPauseOrWait } from "../hooks/HandoffNextStep.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const MAX_HOOK_CONTINUATIONS = 3;
const CONTINUE_PROMPT =
  "Your first next step is assigned to you. Continue the user's requested work now when possible. A Full Stop permits preparation and validation in staging only: do not install staged files, make live project edits, or deliver. Honor an explicit user Stop or pause, pending approvals, the selected permission mode, and genuine blockers. If you cannot proceed without the user, explain the concrete blocker. Keep staged changes and validate them before installation.";

/** Durable effects may replay: the message and command IDs are tied to the source run. */
export const continueHookRun = Effect.fn("HookContinuation.continueHookRun")(function* (input: {
  readonly threadId: ThreadId;
  readonly sourceRunId: RunId;
  readonly messages?: ReadonlyArray<string>;
  readonly stageWorkspaceRoot?: string;
}) {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const messageId = MessageId.make(`message:hook-continuation:${input.sourceRunId}`);
  const projection = yield* threads.getThreadRecords(input.threadId, ["messages", "runs"], {
    messageIds: [messageId],
  });
  if (projection.messages.some((message) => message.id === messageId)) return;
  const sourceProjection = yield* threads.getThreadRecords(input.threadId, ["runs"], {
    runIds: [input.sourceRunId],
  });
  const source = sourceProjection.runs.find((run) => run.id === input.sourceRunId);
  if (!source || source.threadId !== input.threadId) return;
  const hookFailure =
    source.status === "failed"
      ? (yield* threads.getThreadRecords(input.threadId, ["turnItems"], {
          turnItemRunIds: [input.sourceRunId],
        })).turnItems.find(
          (item) =>
            item.type === "error" &&
            item.status === "failed" &&
            item.runId === source.id &&
            item.nodeId === source.rootNodeId &&
            item.failure.code === "hook_blocked",
        )
      : undefined;
  if (source.status !== "completed" && hookFailure === undefined) return;
  let root: OrchestrationV2Run = source;
  let continuationCount = 0;
  const visited = new Set<RunId>([source.id]);
  while (root.hookContinuationOfRunId !== undefined) {
    const parentRunId = root.hookContinuationOfRunId;
    if (visited.has(parentRunId) || continuationCount >= MAX_HOOK_CONTINUATIONS) return;
    const parentProjection = yield* threads.getThreadRecords(input.threadId, ["runs"], {
      runIds: [parentRunId],
    });
    const previous = parentProjection.runs.find((run) => run.id === parentRunId);
    if (!previous || previous.threadId !== input.threadId) return;
    visited.add(previous.id);
    continuationCount += 1;
    root = previous;
  }
  if (continuationCount >= MAX_HOOK_CONTINUATIONS) return;
  const original = yield* threads.getThreadRecords(input.threadId, ["messages"], {
    messageIds: [root.userMessageId],
  });
  const originalMessage = original.messages.find((message) => message.id === root.userMessageId);
  if (!originalMessage || userRequestedPauseOrWait(originalMessage.text)) return;
  yield* threads.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`command:hook-continuation:${input.sourceRunId}`),
    threadId: input.threadId,
    messageId,
    text:
      hookFailure === undefined
        ? CONTINUE_PROMPT
        : `A turn-end hook blocked the previous output. Correct it to follow the hook's rule below.\n\nHook rule and correction:\n${input.messages?.filter(Boolean).join("\n") || (hookFailure.type === "error" ? hookFailure.failure.message : "")}\n\n${CONTINUE_PROMPT}`,
    notification: {
      source: { kind: "system" },
      outcome: "updated",
      summary: "Continuing your task",
      detail: "The next step belongs to the agent.",
    },
    attachments: [],
    modelSelection: source.modelSelection,
    dispatchMode: { type: "start_immediately" },
    createdBy: "agent",
    creationSource: "server",
    hookContinuationOfRunId: input.sourceRunId,
    ...(input.stageWorkspaceRoot === undefined
      ? {}
      : { hookStageWorkspaceRoot: input.stageWorkspaceRoot }),
  });
});
