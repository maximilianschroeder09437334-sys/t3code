import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ChatAttachmentId } from "./chatAttachment.ts";
import * as Schema from "effect/Schema";

const attachmentFields = {
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: NonNegativeInt,
};
export const ThreadNoteAttachmentInput = Schema.Union([
  Schema.Struct({ type: Schema.Literal("image"), ...attachmentFields }),
  Schema.Struct({ type: Schema.Literal("file"), ...attachmentFields }),
]);
export type ThreadNoteAttachmentInput = typeof ThreadNoteAttachmentInput.Type;

export const ThreadNoteAttachment = Schema.Union([
  Schema.Struct({ type: Schema.Literal("image"), ...attachmentFields, assetUrl: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(4096))) }),
  Schema.Struct({ type: Schema.Literal("file"), ...attachmentFields, assetUrl: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(4096))) }),
]);
export type ThreadNoteAttachment = typeof ThreadNoteAttachment.Type;

export const ThreadNote = Schema.Struct({
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  createdAt: IsoDateTime,
  content: Schema.String,
  attachments: Schema.Array(ThreadNoteAttachment),
});
export type ThreadNote = typeof ThreadNote.Type;

export const ThreadNotesListInput = Schema.Struct({ threadId: ThreadId });
export type ThreadNotesListInput = typeof ThreadNotesListInput.Type;
export const ThreadNotesListResult = Schema.Struct({
  threadId: ThreadId,
  notes: Schema.Array(ThreadNote),
  truncated: Schema.Boolean,
});
export type ThreadNotesListResult = typeof ThreadNotesListResult.Type;

export const ThreadNotesCreateInput = Schema.Struct({
  threadId: ThreadId,
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  content: TrimmedNonEmptyString.check(Schema.isMaxLength(16_384)),
  attachments: Schema.optional(Schema.Array(ThreadNoteAttachmentInput).check(Schema.isMaxLength(8))),
});
export type ThreadNotesCreateInput = typeof ThreadNotesCreateInput.Type;
export const ThreadNotesUpdateInput = Schema.Struct({
  threadId: ThreadId,
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  content: TrimmedNonEmptyString.check(Schema.isMaxLength(16_384)),
  attachments: Schema.optional(Schema.Array(ThreadNoteAttachmentInput).check(Schema.isMaxLength(8))),
});
export type ThreadNotesUpdateInput = typeof ThreadNotesUpdateInput.Type;
export const ThreadNotesDeleteInput = Schema.Struct({
  threadId: ThreadId,
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
});
export type ThreadNotesDeleteInput = typeof ThreadNotesDeleteInput.Type;
export const ThreadNotesMutationResult = Schema.Struct({
  threadId: ThreadId,
  requestId: TrimmedNonEmptyString,
  created: Schema.optional(Schema.Boolean),
  deleted: Schema.optional(Schema.Boolean),
  updated: Schema.optional(Schema.Boolean),
});
export type ThreadNotesMutationResult = typeof ThreadNotesMutationResult.Type;
