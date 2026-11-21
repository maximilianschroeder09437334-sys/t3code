import {
  CommandId,
  MessageId,
  type OrchestrationV2Run,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const MAX_HOOK_CONTINUATIONS = 3;
const CONTINUE_PROMPT =
  "Your first next step is assigned to you. Continue the user's requested work now when possible. Respect an explicit pause or Full Stop, pending approvals, the selected permission mode, and genuine blockers. If you cannot proceed without the user, explain the concrete blocker. Keep staged changes and validate them before installation.";

/** Durable effects may replay: the message and command IDs are tied to the source run. */
export const continueHookRun = Effect.fn("HookContinuation.continueHookRun")(function* (input: {
  readonly threadId: ThreadId;
  readonly sourceRunId: RunId;
  readonly stageWorkspaceRoot?: string;
}) {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const messageId = MessageId.make(`message:hook-continuation:${input.sourceRunId}`);
  const projection = yield* threads.getThreadRecords(input.threadId, ["messages", "runs"], {
    messageIds: [messageId],
  });
  if (projection.messages.some((message) => message.id === messageId)) return;
  const source = projection.runs.find((run) => run.id === input.sourceRunId);
  if (!source || source.status !== "completed") return;
  let root: OrchestrationV2Run = source;
  let count = 0;
  const visited = new Set<RunId>();
  while (root.hookContinuationOfRunId !== undefined) {
    if (visited.has(root.id) || ++count >= MAX_HOOK_CONTINUATIONS) return;
    visited.add(root.id);
    const previous = projection.runs.find((run) => run.id === root.hookContinuationOfRunId);
    if (!previous) return;
    root = previous;
  }
  const original = yield* threads.getThreadRecords(input.threadId, ["messages"], {
    messageIds: [root.userMessageId],
  });
  const originalMessage = original.messages.find((message) => message.id === root.userMessageId);
  if (
    !originalMessage ||
    /(?:\b(?:full[ -]stop|pause|stop work|wait (?:for|until)|(?:do not|don't)\s+(?:implement|change|edit|proceed|write|continue))\b|(?:^|[.!?]\s*)(?:please\s+)?(?:stop|wait)(?:[.!?]|$|\s+(?:here|now|for|until)\b))/i.test(
      originalMessage.text,
    )
  )
    return;
  yield* threads.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`command:hook-continuation:${input.sourceRunId}`),
    threadId: input.threadId,
    messageId,
    text: CONTINUE_PROMPT,
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
