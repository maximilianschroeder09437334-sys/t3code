import * as Schema from "effect/Schema";
import { RunId, ThreadId, TurnItemId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

const Binding = Schema.Struct({
  driver: Schema.Literals(["codex", "claude", "claudeAgent"]),
  selection: ModelSelection,
});
/** Local server configuration, absent means disabled. No request can override it. */
export const RootOwnerUsageLimitFailover = Schema.Struct({
  enabled: Schema.Boolean,
  revision: TrimmedNonEmptyString,
  source: Binding,
  destination: Binding,
});
export type RootOwnerUsageLimitFailover = typeof RootOwnerUsageLimitFailover.Type;

export const UsageLimitFailoverIntent = Schema.Struct({
  type: Schema.Literal("usage-limit-failover"),
  version: Schema.Literal(1),
  sourceThreadId: ThreadId,
  failedRunId: RunId,
  failureItemId: TurnItemId,
  failureFingerprint: TrimmedNonEmptyString,
  policyRevision: TrimmedNonEmptyString,
  sourceSelection: ModelSelection,
  destinationSelection: ModelSelection,
  lineageId: TrimmedNonEmptyString,
});
export type UsageLimitFailoverIntent = typeof UsageLimitFailoverIntent.Type;
