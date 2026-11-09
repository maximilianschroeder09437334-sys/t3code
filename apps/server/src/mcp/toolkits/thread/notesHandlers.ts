import {
  OrchestratorMcpFailure,
  type ThreadId,
  type ThreadNoteAttachmentInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ThreadNotes from "../../ThreadNotes.ts";
import { assertSameLink } from "../../linkOrigin.ts";
import {
  assertLiveCaller,
  assertTargetWithinLimits,
  readCaller,
  unavailable,
} from "../../threadAccess.ts";
import { ThreadNotesToolkit } from "./tools.ts";

type ThreadNotesInput = {
  readonly action: "read" | "save" | "delete";
  readonly threadId?: ThreadId | undefined;
  readonly requestId?: string | undefined;
  readonly text?: string | undefined;
  readonly attachments?: ReadonlyArray<ThreadNoteAttachmentInput> | undefined;
};

const required = <A>(value: A | undefined, name: string) =>
  value === undefined
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `This action needs \`${name}\`.`,
        }),
      )
    : Effect.succeed(value);

const authorizedThread = Effect.fn("mcp.authorizedNoteThread")(function* (
  requestedThreadId: ThreadId | undefined,
) {
  const caller = yield* readCaller();
  yield* assertLiveCaller(caller);
  const targetId = requestedThreadId ?? caller.caller?.id;
  if (targetId === undefined)
    return yield* new OrchestratorMcpFailure({
      code: "target_required",
      message: "Pass threadId when this MCP client is not running inside a T3 thread.",
    });
  const target = yield* caller.threads.getThreadShell(targetId).pipe(Effect.mapError(unavailable));
  if (target === null || target.deletedAt !== null)
    return yield* new OrchestratorMcpFailure({
      code: "thread_not_found",
      message: "The target thread was not found.",
    });
  return { caller, target };
});

const readNotes = McpToolAccess.reads((input: ThreadNotesInput) =>
  Effect.gen(function* () {
    const { target } = yield* authorizedThread(input.threadId);
    const result = yield* ThreadNotes.read(target.id).pipe(Effect.mapError(unavailable));
    return {
      threadId: target.id,
      truncated: result.truncated,
      notes: result.notes.map((note) => ({ ...note, untrusted: true as const })),
    };
  }),
);

const writeNotes = McpToolAccess.writesThreads(
  (input: ThreadNotesInput) => [input.threadId],
  (input: ThreadNotesInput) =>
    Effect.gen(function* () {
      const { caller, target } = yield* authorizedThread(input.threadId);
      if (caller.caller !== undefined && !ThreadNotes.threadsShareNotes(caller.caller, target))
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Writing thread notes is limited to the caller's related thread family.",
        });
      yield* assertTargetWithinLimits(caller.limits, target);
      yield* assertSameLink(caller, target);
      const requestId = yield* required(input.requestId, "requestId");
      if (input.action === "save") {
        const candidate = yield* required(input.text, "text");
        const text = ThreadNotes.selectAutomaticNote(candidate);
        if (text === undefined)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "A note needs text and must not contain content that looks like a secret.",
          });
        return {
          threadId: target.id,
          ...(yield* ThreadNotes.append({
            threadId: target.id,
            requestId,
            text,
            ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
          }).pipe(Effect.mapError(unavailable))),
        };
      }
      return {
        threadId: target.id,
        ...(yield* ThreadNotes.remove({ threadId: target.id, requestId }).pipe(
          Effect.mapError(unavailable),
        )),
      };
    }),
);

export const layer = McpToolAccess.toLayer(ThreadNotesToolkit, {
  t3_thread_notes: McpToolAccess.either(
    (input: ThreadNotesInput) => input.action === "read",
    readNotes,
    writeNotes,
  ),
});
