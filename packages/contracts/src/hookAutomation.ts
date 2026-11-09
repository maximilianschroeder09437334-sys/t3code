import * as Schema from "effect/Schema";
import { ProjectId, RunId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { HookEvent } from "./hooks.ts";

export const HookCondition = Schema.Struct({
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  operator: Schema.Literals(["equals", "not-equals", "includes", "exists", "at-least", "at-most"]),
  value: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null])),
});
export type HookCondition = typeof HookCondition.Type;
export const HookRecipe = Schema.Struct({
  version: Schema.Literal(1),
  description: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  event: HookEvent,
  when: Schema.Array(HookCondition).check(Schema.isMaxLength(20)),
  check: Schema.Array(HookCondition).check(Schema.isMaxLength(20)),
  onFailure: Schema.Literals(["block", "warn", "repair"]),
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  repair: Schema.optional(
    Schema.Struct({
      prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(2000)),
      maxAttempts: Schema.Number.check(
        Schema.isInt(),
        Schema.isBetween({ minimum: 1, maximum: 2 }),
      ),
      deadlineSeconds: Schema.Number.check(
        Schema.isInt(),
        Schema.isBetween({ minimum: 1, maximum: 300 }),
      ),
      allowIdleResume: Schema.optional(Schema.Boolean),
    }),
  ),
});
export type HookRecipe = typeof HookRecipe.Type;
export const HookResourceInput = Schema.Struct({
  action: Schema.Literals(["acquire", "renew", "end", "status"]),
  resource: Schema.Literal("computer-use"),
  estimateSeconds: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 10, maximum: 3600 })),
  ),
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  backendEnded: Schema.optional(Schema.Boolean),
});
export type HookResourceInput = typeof HookResourceInput.Type;
export const HookResourceLease = Schema.Struct({
  id: TrimmedNonEmptyString,
  projectId: ProjectId,
  threadId: ThreadId,
  runId: RunId,
  resource: Schema.Literal("computer-use"),
  generation: Schema.Number,
  expiresAt: Schema.Number,
  status: Schema.Literals(["active", "expired", "released", "stopped"]),
  backendEnded: Schema.Boolean,
  notification: Schema.Literals(["pending", "delivered", "held", "none"]),
});
export type HookResourceLease = typeof HookResourceLease.Type;
export const HookResourceResult = Schema.Struct({
  lease: Schema.NullOr(HookResourceLease),
  message: Schema.String,
});
export const HOOK_EVENT_COVERAGE = {
  before_file_write: {
    level: "enforced",
    boundary:
      "T3 staged and project-file writes; external native writes require a provider bridge.",
  },
  before_provider_turn_start: { level: "enforced", boundary: "T3 provider turn starts." },
  turn_end: {
    level: "observed",
    boundary: "Root turn finalization; already displayed text is retained.",
  },
  before_github_push: {
    level: "enforced",
    boundary: "T3-managed registered-project pushes; external shell needs a provider bridge.",
  },
  before_browser_action: {
    level: "enforced",
    boundary: "T3 preview mutation tools; other browsers need a provider bridge.",
  },
  before_tool: {
    level: "adapter-dependent",
    boundary:
      "Requires an installed and human-trusted provider PreToolUse bridge; hosted tools may bypass it.",
  },
  after_tool: {
    level: "adapter-dependent",
    boundary: "Requires a provider PostToolUse bridge; observation cannot undo execution.",
  },
  resource_start: {
    level: "enforced",
    boundary: "T3 resource acquire and renew; native tools require a provider bridge.",
  },
  resource_expired: {
    level: "observed",
    boundary: "Durable host timer; expiry blocks managed use and steers a live owner.",
  },
  resource_end: {
    level: "observed",
    boundary:
      "Agent reports backend release; host does not claim a native release without acknowledgement.",
  },
  thread_stalled: {
    level: "observed",
    boundary: "Registered work obligations only; healthy jobs and explicit waits are excluded.",
  },
  usage_updated: {
    level: "unavailable",
    boundary: "Reserved for a usage adapter; no automatic usage event or spending cap is active.",
  },
  before_app_launch: {
    level: "unavailable",
    boundary:
      "A registered app-launch adapter is still required. Shell launches do not fire this event.",
  },
  after_app_launch: {
    level: "unavailable",
    boundary: "A registered launch-readiness adapter is still required.",
  },
  before_handoff: {
    level: "enforced",
    boundary: "Agent t3_thread_send requests only; other messaging paths need their own adapter.",
  },
  handoff_completed: {
    level: "observed",
    boundary:
      "Actual t3_thread_send delivery receipt, including queued delivery; does not prove task completion.",
  },
} as const satisfies Record<HookEvent, { readonly level: string; readonly boundary: string }>;

export const HookIncident = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  event: Schema.String,
  status: Schema.String,
  updatedAt: Schema.Number,
  attempts: Schema.Number,
  summary: Schema.String,
});
export const HookRuntimeOverview = Schema.Struct({
  leases: Schema.Array(HookResourceLease),
  incidents: Schema.Array(HookIncident),
  checkedAt: Schema.Number,
});
export type HookRuntimeOverview = typeof HookRuntimeOverview.Type;

export const HookWorkInput = Schema.Struct({
  action: Schema.Literals(["register", "progress", "wait", "complete", "cancel"]),
  key: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  summary: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  expectedSeconds: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 10, maximum: 86400 })),
  ),
});
export type HookWorkInput = typeof HookWorkInput.Type;

export const AgentPingInput = Schema.Struct({
  key: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
});
export type AgentPingInput = typeof AgentPingInput.Type;
