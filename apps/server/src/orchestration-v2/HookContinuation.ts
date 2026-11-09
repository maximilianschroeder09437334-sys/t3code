import {
  CommandId,
  MessageId,
  type OrchestrationV2Run,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import { userRequestedPauseOrWait } from "../hooks/HandoffNextStep.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const MAX_HOOK_CONTINUATIONS = 2;
const CONTINUE_PROMPT =
  "Your first next step is assigned to you. Continue the user's requested work now when possible. A Full Stop permits preparation and validation in staging only: do not install staged files, make live project edits, or deliver. Honor an explicit user Stop or pause, pending approvals, the selected permission mode, and genuine blockers. If you cannot proceed without the user, explain the concrete blocker. Keep staged changes and validate them before installation.";

/** Durable effects may replay: the message and command IDs are tied to the source run. */
export const continueHookRun = Effect.fn("HookContinuation.continueHookRun")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly sourceRunId: RunId;
    readonly messages?: ReadonlyArray<string>;
    readonly repair?: { readonly maxAttempts: number; readonly deadlineSeconds: number };
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
    const maxAttempts = Math.min(
      MAX_HOOK_CONTINUATIONS,
      Math.max(1, input.repair?.maxAttempts ?? MAX_HOOK_CONTINUATIONS),
    );
    const deadline = Math.min(300, Math.max(1, input.repair?.deadlineSeconds ?? 300)) * 1000;
    let continuationCount = 0;
    const visited = new Set<RunId>([source.id]);
    while (root.hookContinuationOfRunId !== undefined) {
      const parentRunId = root.hookContinuationOfRunId;
      if (visited.has(parentRunId) || continuationCount >= maxAttempts) return;
      const parentProjection = yield* threads.getThreadRecords(input.threadId, ["runs"], {
        runIds: [parentRunId],
      });
      const previous = parentProjection.runs.find((run) => run.id === parentRunId);
      if (!previous || previous.threadId !== input.threadId) return;
      visited.add(previous.id);
      continuationCount += 1;
      root = previous;
    }
    if (continuationCount >= maxAttempts) return;
    if (
      root.completedAt != null &&
      DateTime.toEpochMillis(yield* DateTime.now) - DateTime.toEpochMillis(root.completedAt) >
        deadline
    )
      return;
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
          ? `${input.messages?.filter(Boolean).length ? `Hook feedback:\n${input.messages.filter(Boolean).join("\n")}\n\n` : ""}${CONTINUE_PROMPT}`
          : `A turn-end hook blocked the previous output. Correct it to follow the hook's rule below.\n\nWhat went wrong:\n${input.messages?.filter(Boolean).join("\n") || (hookFailure.type === "error" ? hookFailure.failure.message : "")}\n\nRead the applicable AGENTS.md and fix the output. Agent steps start with Codex:. Route another chat as Codex: followed by its exact thread reference and task; use Codex: WAIT on for a real wait. Do not perform another thread's task, bypass approvals or resume stopped work.`,
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
  },
  (effect, input) =>
    effect.pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const threads = yield* ThreadManagementService.ThreadManagementService;
          const projection = yield* threads.getThreadRecords(input.threadId, []);
          if (projection.thread?.lineage?.relationshipToParent === "subagent") {
            yield* threads.recoverDelegatedTask(input.threadId, input.sourceRunId);
          }
        }),
      ),
    ),
);
