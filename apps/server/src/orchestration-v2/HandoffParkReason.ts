import type { HandoffRequest } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** Diagnostics only. Parsing this envelope never grants transfer authority. */
export const HandoffParkReason = Schema.Struct({
  type: Schema.Literal("handoff.parked"),
  version: Schema.Literal(1),
  sourceThreadId: Schema.String,
  requestId: Schema.String,
  sourceRunId: Schema.NullOr(Schema.String),
  generation: Schema.NullOr(Schema.String),
  category: Schema.Literals(["blocked", "unknown", "manual_review", "authority"]),
  retryable: Schema.Boolean,
  detail: Schema.String.check(Schema.isMaxLength(512)),
});
export type HandoffParkReason = typeof HandoffParkReason.Type;
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(HandoffParkReason));
export const decodeParkReason = (text: string | null) => decode(text);
export const encodeParkReason = (
  request: HandoffRequest,
  reason: Pick<HandoffParkReason, "category" | "retryable" | "generation" | "detail">,
) =>
  JSON.stringify({
    type: "handoff.parked",
    version: 1,
    sourceThreadId: request.sourceThreadId,
    requestId: `core-handoff:${request.sourceThreadId}`,
    sourceRunId: request.sourceRunId ?? null,
    ...reason,
    detail: reason.detail.slice(0, 512),
  } satisfies HandoffParkReason);
