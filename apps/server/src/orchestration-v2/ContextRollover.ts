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
  "This native session reached 250,000 context tokens. Do not compact or start another delegate. Let existing jobs finish, save their results, and call the t3_handoff_submit tool (not a thread message). Before submitting, commit and push your work to GitHub where the project allows it, and record the pushed SHA in state.commits.";

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

export function contextRolloverInstructions(capRunId: string | null, branch: string | null) {
  return `${contextRolloverLimitMessage} Pass contextLimitWork.capRunId=${JSON.stringify(capRunId)} and state.branch=${JSON.stringify(branch)} (the source thread's known branch).`;
}

export const contextHandoffNudgeMessage =
  "This native session reached 150,000 context tokens. Do not compact. If this part is done, call the t3_handoff_submit tool now; the successor starts automatically. Use the source thread's known branch in state.branch. Before submitting, commit and push your work to GitHub where the project allows it, and record the pushed SHA in state.commits.";

export function contextRolloverFollowupId(provider: OrchestrationV2ProviderThread) {
  const notice = contextRolloverNoticeId(provider, CONTEXT_ROLLOVER_LIMIT);
  return notice === undefined ? undefined : TurnItemId.make(`relay-forced-followup:${notice}`);
}
