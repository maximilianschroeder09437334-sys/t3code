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

const handOffSteps =
  "commit and push your work, update STATE, then start the successor yourself with t3_thread_launch (same project and model, explicit effort, full brief) and confirm it runs with t3_thread_list. Do not call t3_handoff_submit. Delegated child: do not launch a successor; save your result and report it to your parent.";

export const contextRolloverLimitMessage = `This thread reached 250,000 context tokens. Do not compact or start another delegate. Hand off now: ${handOffSteps}`;

export function hasVoluntaryHandoffNudge(records: {
  readonly thread: { readonly activeProviderThreadId: string | null };
  readonly providerThreads: ReadonlyArray<OrchestrationV2ProviderThread>;
  readonly turnItems: ReadonlyArray<{ readonly id: TurnItemId }>;
}) {
  const provider = records.providerThreads.find(
    (p) => p.id === records.thread.activeProviderThreadId,
  );
  const id =
    provider === undefined ? undefined : contextRolloverNoticeId(provider, CONTEXT_HANDOFF_NUDGE);
  return id !== undefined && records.turnItems.some((item) => item.id === id);
}

export function contextRolloverInstructions(_capRunId: string | null, branch: string | null) {
  return `${contextRolloverLimitMessage} The successor uses branch ${JSON.stringify(branch)}.`;
}

export const contextHandoffNudgeMessage = `This thread reached 150,000 context tokens. Do not compact. At the next natural break, hand off: ${handOffSteps}`;

export function contextRolloverFollowupId(provider: OrchestrationV2ProviderThread) {
  const notice = contextRolloverNoticeId(provider, CONTEXT_ROLLOVER_LIMIT);
  return notice === undefined ? undefined : TurnItemId.make(`relay-forced-followup:${notice}`);
}
