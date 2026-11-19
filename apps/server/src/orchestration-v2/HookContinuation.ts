import {
  CommandId,
  MessageId,
  type OrchestrationV2Run,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as EffectOutbox from "./EffectOutbox.ts";
import { userRequestedPauseOrWait } from "../hooks/HandoffNextStep.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const MAX_HOOK_CONTINUATIONS = 2;
const MAX_CHAIN_RUNS = 8;
const CONTINUE_PROMPT =
  "Your first next step is assigned to you. Continue the user's requested work now when possible. A Full Stop permits preparation and validation in staging only: do not install staged files, make live project edits, or deliver. Honor an explicit user Stop or pause, pending approvals, the selected permission mode, and genuine blockers. If you cannot proceed without the user, explain the concrete blocker. Keep staged changes and validate them before installation.";

/** A rewrite after a turn-end block only corrects the report; it is not new work. */
export const isHookRewriteRun = (
  run: Pick<OrchestrationV2Run, "hookContinuationOfRunId">,
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status">>,
) =>
  run.hookContinuationOfRunId !== undefined &&
  runs.find((parent) => parent.id === run.hookContinuationOfRunId)?.status === "failed";

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
    const rewrite = hookFailure !== undefined;
    // Rewrites are capped per block; resumed work is capped across the whole chain.
    const limit = rewrite
      ? Math.min(
          MAX_HOOK_CONTINUATIONS,
          Math.max(1, input.repair?.maxAttempts ?? MAX_HOOK_CONTINUATIONS),
        )
      : MAX_HOOK_CONTINUATIONS;
    const deadline = Math.min(300, Math.max(1, input.repair?.deadlineSeconds ?? 300)) * 1000;
    let root: OrchestrationV2Run = source;
    let counted = 0;
    let consecutive = true;
    const visited = new Set<RunId>([source.id]);
    while (root.hookContinuationOfRunId !== undefined) {
      const parentRunId = root.hookContinuationOfRunId;
      if (visited.has(parentRunId) || counted >= limit || visited.size > MAX_CHAIN_RUNS) return;
      const parentProjection = yield* threads.getThreadRecords(input.threadId, ["runs"], {
        runIds: [parentRunId],
      });
      const previous = parentProjection.runs.find((run) => run.id === parentRunId);
      if (!previous || previous.threadId !== input.threadId) return;
      visited.add(previous.id);
      // Only a turn-end block (a failed run) is continued by a rewrite.
      const linkIsRewrite = previous.status === "failed";
      if (linkIsRewrite === rewrite && consecutive) counted += 1;
      else if (rewrite) consecutive = false;
      root = previous;
    }
    if (counted >= limit) return;
    if (
      source.completedAt != null &&
      DateTime.toEpochMillis(yield* DateTime.now) - DateTime.toEpochMillis(source.completedAt) >
        deadline
    )
      return;
    if (!rewrite && root.startedAt != null) {
      // Work after a handoff request would invalidate it; the successor owns the next step.
      const outbox = yield* Effect.serviceOption(EffectOutbox.EffectOutboxV2);
      const handoff = Option.isSome(outbox)
        ? yield* outbox.value.get(`core-handoff:${input.threadId}`)
        : Option.none();
      if (
        Option.isSome(handoff) &&
        handoff.value.status !== "cancelled" &&
        Date.parse(handoff.value.createdAt) >= DateTime.toEpochMillis(root.startedAt)
      )
        return;
    }
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
          : `A turn-end hook blocked the previous output. Correct it to follow the hook's rule below.\n\nWhat went wrong:\n${input.messages?.filter(Boolean).join("\n") || (hookFailure.type === "error" ? hookFailure.failure.message : "")}\n\nRead the applicable AGENTS.md and fix the output. Rewrite only that reply; T3 resumes your remaining work afterwards when its first next step is yours. Do not perform another thread's task, bypass approvals or resume stopped work.`,
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
            yield* threads.recoverDelegatedTask(input.threadId, { sourceRunId: input.sourceRunId });
          }
        }),
      ),
    ),
);
