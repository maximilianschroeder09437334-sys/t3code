import * as Digest from "effect/crypto/Digest";
import { HandoffReadiness } from "@t3tools/contracts";
import * as Git from "../../../git/GitManager.ts";
import * as Sessions from "../../../orchestration-v2/ProviderSessionManager.ts";
import * as Projects from "../../../orchestration-v2/ProjectStore.ts";
import * as Terminals from "../../../terminal/Manager.ts";
import {
  HandoffInput,
  OrchestratorMcpFailure,
  ThreadId,
  RuntimeRequestId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as EffectOutbox from "../../../orchestration-v2/EffectOutbox.ts";

const reasonSummary = Schema.Struct({
  total: Schema.Number,
  items: Schema.Array(Schema.String),
  detailsOmitted: Schema.Boolean,
});
const readinessSummary = Schema.Struct({
  observationalOnly: HandoffReadiness.fields.observationalOnly,
  transferAuthorized: HandoffReadiness.fields.transferAuthorized,
  classification: HandoffReadiness.fields.classification,
  generation: HandoffReadiness.fields.generation,
  expectedGenerationMatches: HandoffReadiness.fields.expectedGenerationMatches,
  stable: HandoffReadiness.fields.stable,
  ownershipScope: HandoffReadiness.fields.ownershipScope,
  blockers: reasonSummary,
  unknowns: reasonSummary,
  manualReview: reasonSummary,
  evidence: Schema.Struct({
    kind: Schema.Literal("revalidate_generation"),
    generation: Schema.String,
  }),
});

export const HandoffToolkit = Toolkit.make(
  Tool.make("t3_handoff_request_approval", {
    description:
      "Request a one-time manual readiness review for your own parked handoff using the exact generation from t3_handoff_readiness. This action records a pending review only, creates no successor or agent turn, and grants no transfer permission. A separately authenticated client may accept, decline or cancel it; MCP callers cannot decide it. Known blockers, essential unknowns, stale generations and changed source settings refuse. Do not poll or repeat this action to obtain approval.",
    parameters: Schema.Struct({ expectedGeneration: Schema.String }),
    success: Schema.Struct({
      requestId: RuntimeRequestId,
      generation: Schema.String,
      successorThreadId: ThreadId,
      status: Schema.Literal("awaiting_review"),
      transferAuthorized: Schema.Literal(false),
      sequence: Schema.Number,
    }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      McpInvocationContext.McpInvocationContext,
      ThreadManagement.ThreadManagementService,
      EffectOutbox.EffectOutboxV2,
      Git.GitManager,
      Sessions.ProviderSessionManagerV2,
      Projects.ProjectStoreV2,
      Terminals.TerminalManager,
      Digest.Digest,
    ],
  }).annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients),
  Tool.make("t3_handoff_readiness", {
    description:
      "Read observational readiness evidence for your own authenticated thread's parked handoff. Returns a compact classification and reason summary with counts and an opaque generation. Raw histories and Git diffs stay server-side. Omitted details are explicit. Evidence references request revalidation of that generation, not a stored authorization or durable evidence archive. Unknown or missing observations never mean idle. This query creates no successor, performs no extra agent turns, polling or resume, and grants no transfer permission. Explicit human authorization is a separate future action; new requests remain parked. Full handoff still requires a later guarded transfer consuming and revalidating this same generation.",
    parameters: Schema.Struct({
      expectedGeneration: Schema.optionalKey(
        Schema.String.annotate({
          description: "Compare with a prior readiness generation; this grants no permission.",
        }),
      ),
    }),
    success: Schema.toCodecJson(readinessSummary),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      McpInvocationContext.McpInvocationContext,
      ThreadManagement.ThreadManagementService,
      EffectOutbox.EffectOutboxV2,
      Git.GitManager,
      Sessions.ProviderSessionManagerV2,
      Projects.ProjectStoreV2,
      Terminals.TerminalManager,
      Digest.Digest,
    ],
  }).annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients),
  Tool.make("t3_handoff_submit", {
    description:
      "Submit a durable handoff for your own authenticated thread. Include goal, decisions with why, state (branch, commits, verified), deadEnds, next, and pointers; the complete JSON must be at most 6000 characters. The first submission wins. The request is parked awaiting authoritative ownership transfer; no new successor is created or started. The source remains open. Acceptance preserves the request only and is not delivery or ownership transfer.",
    parameters: HandoffInput,
    success: Schema.Struct({
      accepted: Schema.Boolean,
      status: Schema.Literal("awaiting_transfer"),
      successorThreadId: ThreadId,
      sourceRetained: Schema.Boolean,
    }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      McpInvocationContext.McpInvocationContext,
      ThreadManagement.ThreadManagementService,
      EffectOutbox.EffectOutboxV2,
    ],
  }).annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients),
);
