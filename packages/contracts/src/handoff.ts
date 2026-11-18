import { OrchestrationV2ThreadProjection } from "./orchestrationV2.ts";
import * as Schema from "effect/Schema";
import { ProjectId, RunId, ThreadId, TrimmedNonEmptyString, TurnItemId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode, ProviderInteractionMode } from "./providerPolicy.ts";

/** The serialized payload, including field names, must fit in 6000 UTF-16 characters. */
export const HandoffInput = Schema.Struct({
  goal: TrimmedNonEmptyString,
  decisions: Schema.Array(
    Schema.Struct({ decision: TrimmedNonEmptyString, why: TrimmedNonEmptyString }),
  ),
  state: Schema.Struct({
    branch: TrimmedNonEmptyString,
    commits: Schema.Array(TrimmedNonEmptyString),
    verified: Schema.Array(TrimmedNonEmptyString),
  }),
  deadEnds: Schema.Array(TrimmedNonEmptyString),
  next: TrimmedNonEmptyString,
  pointers: Schema.Array(TrimmedNonEmptyString),
  contextLimitWork: Schema.optionalKey(
    Schema.Struct({
      capRunId: RunId,
      results: Schema.Array(
        Schema.Struct({
          commandItemId: Schema.optionalKey(TurnItemId),
          outcome: TrimmedNonEmptyString,
          evidence: TrimmedNonEmptyString,
        }),
      ),
    }),
  ),
}).check(
  Schema.makeFilter((value) => JSON.stringify(value).length <= 6000, {
    expected: "a complete serialized handoff of at most 6000 characters",
  }),
);
export type HandoffInput = typeof HandoffInput.Type;

export const HandoffRequest = Schema.Struct({
  type: Schema.Literal("thread.handoff"),
  handoff: HandoffInput,
  projectId: ProjectId,
  sourceThreadId: ThreadId,
  successorThreadId: ThreadId,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  worktreePath: Schema.NullOr(Schema.String),
  branch: Schema.String,
});
export type HandoffRequest = typeof HandoffRequest.Type;

// Handoff-only observational contract; never an execution authorization.
export const HandoffWorkspace = Schema.Struct({
  root: Schema.String,
  branch: Schema.NullOr(Schema.String),
  head: Schema.String,
  status: Schema.String,
  indexDiff: Schema.String,
  worktreeDiff: Schema.String,
  untracked: Schema.String,
  submodules: Schema.String,
  checkpointRef: Schema.NullOr(Schema.String),
  checkpointCommit: Schema.NullOr(Schema.String),
  checkpointMatches: Schema.NullOr(Schema.Boolean),
  checkpointError: Schema.NullOr(Schema.String),
});
export type HandoffWorkspace = typeof HandoffWorkspace.Type;
export const HandoffProviderObservation = Schema.Struct({
  providerThreadId: Schema.String,
  driver: Schema.String,
  sessionId: Schema.NullOr(Schema.String),
  live: Schema.Boolean,
  idleGeneration: Schema.NullOr(Schema.Number),
  busyTurns: Schema.Array(Schema.String),
  sessionProbe: Schema.NullOr(Schema.Boolean),
  threadProbe: Schema.NullOr(Schema.Boolean),
  completeAppOwnedCoverage: Schema.Boolean,
  coverage: Schema.Array(Schema.String),
  limitations: Schema.Array(Schema.String),
  errors: Schema.Array(Schema.String),
});
export type HandoffProviderObservation = typeof HandoffProviderObservation.Type;
export const HandoffTerminalObservation = Schema.Struct({
  threadId: Schema.String,
  terminalId: Schema.String,
  cwd: Schema.String,
  status: Schema.String,
  pid: Schema.NullOr(Schema.Number),
  sequence: Schema.Number,
  cachedRunning: Schema.Boolean,
  running: Schema.NullOr(Schema.Boolean),
  processIds: Schema.NullOr(Schema.Array(Schema.Number)),
  error: Schema.NullOr(Schema.String),
});
export type HandoffTerminalObservation = typeof HandoffTerminalObservation.Type;
export const HandoffReadinessRecords = Schema.Struct({
  thread: OrchestrationV2ThreadProjection.fields.thread,
  runs: OrchestrationV2ThreadProjection.fields.runs,
  attempts: OrchestrationV2ThreadProjection.fields.attempts,
  nodes: OrchestrationV2ThreadProjection.fields.nodes,
  subagents: OrchestrationV2ThreadProjection.fields.subagents,
  providerSessions: OrchestrationV2ThreadProjection.fields.providerSessions,
  providerThreads: OrchestrationV2ThreadProjection.fields.providerThreads,
  providerTurns: OrchestrationV2ThreadProjection.fields.providerTurns,
  runtimeRequests: OrchestrationV2ThreadProjection.fields.runtimeRequests,
  messages: OrchestrationV2ThreadProjection.fields.messages,
  plans: OrchestrationV2ThreadProjection.fields.plans,
  turnItems: OrchestrationV2ThreadProjection.fields.turnItems,
  checkpointScopes: OrchestrationV2ThreadProjection.fields.checkpointScopes,
  checkpoints: OrchestrationV2ThreadProjection.fields.checkpoints,
  contextHandoffs: OrchestrationV2ThreadProjection.fields.contextHandoffs,
  contextTransfers: OrchestrationV2ThreadProjection.fields.contextTransfers,
});
export type HandoffReadinessRecords = typeof HandoffReadinessRecords.Type;
export const HandoffReadinessFrame = Schema.Struct({
  sourceRecords: Schema.NullOr(HandoffReadinessRecords),
  sourceSequence: Schema.NullOr(Schema.Number),
  childIds: Schema.NullOr(Schema.Array(ThreadId)),
  children: Schema.Array(
    Schema.Struct({
      id: ThreadId,
      records: Schema.NullOr(HandoffReadinessRecords),
      sequence: Schema.NullOr(Schema.Number),
    }),
  ),
  request: Schema.NullOr(Schema.String),
  parkedRequest: Schema.NullOr(HandoffRequest),
  workspace: Schema.NullOr(HandoffWorkspace),
  providers: Schema.Array(HandoffProviderObservation),
  terminals: Schema.NullOr(Schema.Array(HandoffTerminalObservation)),
  blockers: Schema.Array(Schema.String),
  unknowns: Schema.Array(Schema.String),
  manualReview: Schema.Array(Schema.String),
});
export type HandoffReadinessFrame = typeof HandoffReadinessFrame.Type;
export const HandoffReadiness = Schema.Struct({
  releaseEvidence: Schema.String,
  sourceThreadId: ThreadId,
  observationalOnly: Schema.Literal(true),
  transferAuthorized: Schema.Literal(false),
  classification: Schema.Literals([
    "known_blocked",
    "unknown",
    "manual_review",
    "automatically_eligible",
  ]),
  generation: Schema.String,
  expectedGenerationMatches: Schema.NullOr(Schema.Boolean),
  ownershipScope: Schema.Literal("app-owned-only; arbitrary external processes excluded"),
  stable: Schema.Boolean,
  before: HandoffReadinessFrame,
  after: HandoffReadinessFrame,
});
export type HandoffReadiness = typeof HandoffReadiness.Type;
