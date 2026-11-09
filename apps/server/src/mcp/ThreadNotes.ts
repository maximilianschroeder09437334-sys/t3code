import {
  OrchestratorMcpFailure,
  ThreadNoteAttachmentInput,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";
import {
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";

const MAX_NOTE_BYTES = 16_384;
const MAX_TOTAL_BYTES = 1_048_576;
const MAX_READ_BYTES = 32_768;
const attachmentsJsonSchema = Schema.fromJsonString(
  Schema.toCodecJson(Schema.Array(ThreadNoteAttachmentInput)),
);

export const threadsShareNotes = (
  caller: Pick<OrchestrationV2ThreadShell, "projectId" | "lineage">,
  target: Pick<OrchestrationV2ThreadShell, "projectId" | "lineage">,
) =>
  caller.projectId === target.projectId &&
  caller.lineage.rootThreadId === target.lineage.rootThreadId;

const containsSecret = (text: string) =>
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b|\b(?:password|passwd|secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|bearer)\s*[:=]\s*(?:bearer\s+)?\S+/i.test(
    text,
  );

export const selectAutomaticNote = (text: string) => {
  const note = text.trim();
  return note && note.length > 0 && !containsSecret(note) ? note : undefined;
};

export const append = Effect.fn("ThreadNotes.append")(function* (input: {
  readonly threadId: ThreadId;
  readonly requestId: string;
  readonly text: string;
  readonly attachments?: ReadonlyArray<ThreadNoteAttachmentInput>;
}) {
  const threadSegment = toSafeThreadAttachmentSegment(input.threadId);
  if (
    (input.attachments ?? []).some(
      (attachment) =>
        threadSegment === null ||
        parseThreadSegmentFromAttachmentId(attachment.id) !== threadSegment,
    )
  ) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "Note attachments must belong to the target thread.",
    });
  }
  if (
    input.requestId.trim().length === 0 ||
    input.requestId.length > 512 ||
    input.text.trim().length === 0 ||
    Buffer.byteLength(input.text, "utf8") > MAX_NOTE_BYTES ||
    input.text.includes("\0") ||
    containsSecret(input.text)
  ) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "The note is empty, too large, or contains a value that looks like a secret.",
    });
  }
  const sql = yield* SqlClient.SqlClient;
  const content = input.text.trim();
  const now = yield* Clock.currentTimeMillis;
  const createdAt = DateTime.formatIso(DateTime.makeUnsafe(now));
  const attachmentsJson = yield* Schema.encodeEffect(attachmentsJsonSchema)(
    input.attachments ?? [],
  );
  const rows = yield* sql<{ readonly created: number }>`
    INSERT INTO thread_notes (thread_id, request_id, created_at, content, attachments_json)
    SELECT ${input.threadId}, ${input.requestId}, ${createdAt}, ${content}, ${attachmentsJson}
    WHERE COALESCE((
      SELECT SUM(length(CAST(content AS BLOB))) FROM thread_notes WHERE thread_id = ${input.threadId}
    ), 0) + ${Buffer.byteLength(content, "utf8")} <= ${MAX_TOTAL_BYTES}
    ON CONFLICT (thread_id, request_id) DO NOTHING
    RETURNING 1 AS created
  `;
  if (rows.length === 0) {
    const previous = yield* sql<{ readonly content: string }>`
      SELECT content FROM thread_notes WHERE thread_id = ${input.threadId} AND request_id = ${input.requestId}
    `;
    if (previous[0]?.content === content) return { created: false };
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        previous.length > 0
          ? "This note request ID was already used for different text."
          : "This thread's notes have reached their storage limit.",
    });
  }
  return { created: rows.length > 0 };
});

export const remove = Effect.fn("ThreadNotes.remove")(function* (input: {
  readonly threadId: ThreadId;
  readonly requestId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly deleted: number }>`
    DELETE FROM thread_notes
    WHERE thread_id = ${input.threadId} AND request_id = ${input.requestId}
    RETURNING 1 AS deleted
  `;
  return { deleted: rows.length > 0 };
});

export const read = Effect.fn("ThreadNotes.read")(function* (threadId: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly request_id: string;
    readonly created_at: string;
    readonly content: string;
    readonly attachments_json: string;
  }>`
    SELECT request_id, created_at, content, attachments_json FROM thread_notes
    WHERE thread_id = ${threadId}
    ORDER BY created_at DESC, request_id DESC
    LIMIT 100
  `;
  const notes: Array<{
    requestId: string;
    createdAt: string;
    content: string;
    attachments: ReadonlyArray<ThreadNoteAttachmentInput>;
  }> = [];
  let bytes = 0;
  for (const row of rows) {
    const size = Buffer.byteLength(row.content, "utf8");
    if (bytes + size > MAX_READ_BYTES) break;
    bytes += size;
    const attachments = yield* Schema.decodeEffect(attachmentsJsonSchema)(row.attachments_json);
    notes.push({
      requestId: row.request_id,
      createdAt: row.created_at,
      content: row.content,
      attachments,
    });
  }
  return {
    notes: notes.reverse(),
    truncated: notes.length < rows.length,
  };
});
