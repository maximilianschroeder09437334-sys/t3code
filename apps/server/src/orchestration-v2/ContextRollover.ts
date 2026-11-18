// @effect-diagnostics nodeBuiltinImport:off -- Synchronous IDs are shared by projection reads and event creation.
import * as NodeCrypto from "node:crypto";
import { TurnItemId, type OrchestrationV2ProviderThread } from "@t3tools/contracts";

export const CONTEXT_HANDOFF_NUDGE = 150_000;
export const CONTEXT_ROLLOVER_LIMIT = 250_000;

const noticePrefix = "context-rollover:";

export function contextRolloverNoticeId(
  provider: OrchestrationV2ProviderThread,
  threshold: typeof CONTEXT_HANDOFF_NUDGE | typeof CONTEXT_ROLLOVER_LIMIT,
) {
  const nativeId = provider.nativeThreadRef?.nativeId;
  if (nativeId === undefined) return undefined;
  const identity = NodeCrypto.createHash("sha256")
    .update(JSON.stringify([provider.id, nativeId]))
    .digest("hex");
  return TurnItemId.make(`${noticePrefix}${threshold}:${identity}`);
}

export function isContextRolloverLimitNotice(itemId: TurnItemId) {
  return itemId.startsWith(`${noticePrefix}${CONTEXT_ROLLOVER_LIMIT}:`);
}

export const contextRolloverLimitMessage =
  "This native session reached 250,000 context tokens. Do not compact or start another delegate. Let existing jobs finish, save their results, and submit a Relay handoff for this run.";

export const contextHandoffNudgeMessage =
  "This native session reached 150,000 context tokens. Do not compact. Consider moving to a new thread at a safe handoff.";
