import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import * as Schema from "effect/Schema";

export const HookEvent = Schema.Literals([
  "before_file_write",
  "before_provider_turn_start",
  "turn_end",
  "before_github_push",
  "before_browser_action",
]);
export type HookEvent = typeof HookEvent.Type;

export const HookStatus = Schema.Literals(["draft", "active"]);
export type HookStatus = typeof HookStatus.Type;

export const HookScope = Schema.Literals(["project", "all-projects"]);
export type HookScope = typeof HookScope.Type;

export const HookDefinition = Schema.Struct({
  id: TrimmedNonEmptyString,
  projectId: ProjectId,
  scope: Schema.optional(HookScope),
  name: TrimmedNonEmptyString,
  event: HookEvent,
  script: Schema.String.check(Schema.isMaxLength(16 * 1024)),
  scriptSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  status: HookStatus,
  enabled: Schema.Boolean,
  createdAt: Schema.Number,
  approvedAt: Schema.optional(Schema.Number),
  approvedEvent: Schema.optional(HookEvent),
  approvedScope: Schema.optional(HookScope),
});
export type HookDefinition = typeof HookDefinition.Type;

export const HookDraftInput = Schema.Struct({
  projectId: ProjectId,
  scope: Schema.optional(HookScope),
  name: TrimmedNonEmptyString,
  event: HookEvent,
  script: Schema.String.check(Schema.isMaxLength(16 * 1024)),
});
export type HookDraftInput = typeof HookDraftInput.Type;

export const HookApproveInput = Schema.Struct({
  projectId: ProjectId,
  hookId: TrimmedNonEmptyString,
  reviewedSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  reviewedEvent: Schema.optional(HookEvent),
  reviewedScope: Schema.optional(HookScope),
});
export type HookApproveInput = typeof HookApproveInput.Type;

export const HookUpdateDraftInput = Schema.Struct({
  projectId: ProjectId,
  hookId: TrimmedNonEmptyString,
  script: Schema.String.check(Schema.isMaxLength(16 * 1024)),
});
export type HookUpdateDraftInput = typeof HookUpdateDraftInput.Type;

export const HookSetEnabledInput = Schema.Struct({
  projectId: ProjectId,
  hookId: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
});
export type HookSetEnabledInput = typeof HookSetEnabledInput.Type;

export const HookStageFileInput = Schema.Struct({
  path: TrimmedNonEmptyString,
  create: Schema.Boolean,
});
export type HookStageFileInput = typeof HookStageFileInput.Type;

export const HookStageFileResult = Schema.Struct({
  candidatePath: Schema.String,
  originalPath: Schema.String,
  originalSha256: Schema.NullOr(Schema.String),
});
export type HookStageFileResult = typeof HookStageFileResult.Type;

export const HookWriteStagedFileInput = Schema.Struct({
  path: TrimmedNonEmptyString,
  contents: Schema.String.check(Schema.isMaxLength(4 * 1024 * 1024)),
});
export type HookWriteStagedFileInput = typeof HookWriteStagedFileInput.Type;

export const HookWriteStagedFileResult = Schema.Struct({
  candidatePath: Schema.String,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type HookWriteStagedFileResult = typeof HookWriteStagedFileResult.Type;

export const HookListInput = Schema.Struct({
  projectId: ProjectId,
  supportedEvents: Schema.optional(Schema.Array(HookEvent)),
});
export type HookListInput = typeof HookListInput.Type;

export const HookDecision = Schema.Struct({
  decision: Schema.Literals(["allow", "block"]),
  message: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  enforcement: Schema.optional(Schema.Literal("managed-worktree")),
  action: Schema.optional(Schema.Literal("install-staged-files")),
  continueWork: Schema.optional(Schema.Boolean),
});
export type HookDecision = typeof HookDecision.Type;

export class HookRegistryError extends Schema.TaggedError<HookRegistryError>()(
  "HookRegistryError",
  {
    reason: Schema.Literals([
      "storage",
      "execution",
      "not-found",
      "not-draft",
      "not-active",
      "approval-mismatch",
      "too-many",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "storage":
        return "Hook registry could not be read or saved.";
      case "execution":
        return "An active hook failed and blocked the operation.";
      case "not-found":
        return "The hook draft was not found.";
      case "not-draft":
        return "Only a draft can be approved.";
      case "not-active":
        return "Only an active hook can be enabled or disabled.";
      case "approval-mismatch":
        return "The hook changed after it was reviewed. Review the latest draft.";
      case "too-many":
        return "This project has reached the hook limit.";
    }
  }
}
