import type {
  HandoffReadinessRecords,
  HandoffRequest,
  ServerProvider,
  ServerSettings,
  UsageLimitFailoverIntent,
} from "@t3tools/contracts";
import { resolveProjectProviderInstanceEnabled } from "@t3tools/contracts";
import {
  latestExecutedRun,
  latestRootProviderFailure,
} from "@t3tools/shared/orchestrationV2ThreadError";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import { agentModelPolicy } from "./AgentModelPolicy.ts";

/** Pure admission check. Capability listings never establish remaining quota. */
export function usageLimitFailoverIntent(
  records: Pick<HandoffReadinessRecords, "thread" | "runs" | "turnItems" | "checkpoints">,
  request: HandoffRequest,
  settings: ServerSettings,
  providers: ReadonlyArray<ServerProvider>,
  nowMs: number,
): UsageLimitFailoverIntent | null {
  const policy = settings.rootOwnerUsageLimitFailover;
  const thread = records.thread;
  const run = latestExecutedRun(records.runs);
  const failure = latestRootProviderFailure(run, records.turnItems);
  const item = records.turnItems
    .filter(
      (item) =>
        item.type === "error" &&
        item.status === "failed" &&
        item.runId === run?.id &&
        item.nodeId === run?.rootNodeId,
    )
    .toSorted(
      (a, b) =>
        DateTime.Order(b.updatedAt, a.updatedAt) ||
        b.ordinal - a.ordinal ||
        (a.id === b.id ? 0 : a.id > b.id ? -1 : 1),
    )[0];
  if (
    !policy?.enabled ||
    !run ||
    !item ||
    failure?.class !== "usage_limit" ||
    request.sourceRunId !== run.id ||
    request.sourceThreadId !== thread.id ||
    thread.lineage.parentThreadId !== null ||
    thread.lineage.sideChat === true ||
    thread.agentExecutionIntent?.restrictedTools !== undefined ||
    thread.linkOrigin !== undefined ||
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    ((thread.settledAt !== null || thread.settledOverride === "settled") &&
      !["released", "started"].includes(thread.handoffTransfer?.state ?? "")) ||
    thread.handoffStopCommandId !== undefined ||
    request.target !== undefined ||
    !modelSelectionsEqual(thread.modelSelection, policy.source.selection) ||
    !modelSelectionsEqual(run.modelSelection, policy.source.selection) ||
    run.providerInstanceId !== policy.source.selection.instanceId ||
    !modelSelectionsEqual(
      request.intent?.sourceSelection ?? request.modelSelection,
      policy.source.selection,
    ) ||
    request.runtimeMode !== thread.runtimeMode ||
    request.interactionMode !== thread.interactionMode ||
    (policy.source.driver === "codex") === (policy.destination.driver === "codex") ||
    policy.source.selection.instanceId === policy.destination.selection.instanceId ||
    !records.checkpoints.some((checkpoint) => checkpoint.status === "ready") ||
    records.runs.some((candidate) =>
      ["preparing", "queued", "starting", "running", "waiting"].includes(candidate.status),
    )
  )
    return null;
  for (const binding of [policy.source, policy.destination]) {
    if (
      !resolveProjectProviderInstanceEnabled(
        settings,
        thread.projectId,
        binding.selection.instanceId,
      )
    )
      return null;
    const matching = providers.filter(
      (provider) => provider.instanceId === binding.selection.instanceId,
    );
    const provider = matching[0];
    const checkedAt = provider === undefined ? NaN : Date.parse(provider.checkedAt);
    if (
      matching.length !== 1 ||
      !provider ||
      provider.driver !== binding.driver ||
      !Number.isFinite(checkedAt) ||
      checkedAt > nowMs ||
      nowMs - checkedAt > 5 * 60 * 1000 ||
      !provider.enabled ||
      !provider.installed ||
      provider.status !== "ready" ||
      provider.auth.status !== "authenticated" ||
      provider.availability !== "available" ||
      !provider.supportedRuntimeModes?.includes(thread.runtimeMode) ||
      /opus/i.test(binding.selection.model) ||
      agentModelPolicy({ selection: binding.selection, provider }) !== null
    )
      return null;
    const model = provider.models.find((model) => model.slug === binding.selection.model);
    if (!model || /opus/i.test(`${model.slug} ${model.name}`)) return null;
    const tier = model.capabilities?.optionDescriptors?.find(
      (option) => option.id === "serviceTier" || option.id === "tier",
    );
    if (tier && !binding.selection.options?.some((option) => option.id === tier.id)) return null;
  }
  const intent: UsageLimitFailoverIntent = {
    type: "usage-limit-failover",
    version: 1,
    sourceThreadId: thread.id,
    failedRunId: run.id,
    failureItemId: item.id,
    failureFingerprint: JSON.stringify([
      item.id,
      failure.code,
      failure.resetAt ?? null,
      DateTime.toEpochMillis(item.updatedAt),
    ]),
    policyRevision: policy.revision,
    sourceSelection: policy.source.selection,
    destinationSelection: policy.destination.selection,
    lineageId: `usage-limit:${thread.id}:${run.id}:${item.id}`,
  };
  // Only the already reserved exact transfer can consult a consumed marker.
  if (
    thread.usageLimitFailoverConsumed !== undefined &&
    (thread.handoffTransfer === undefined ||
      thread.handoffTransfer.state === "cancelled" ||
      thread.usageLimitFailoverConsumed.lineageId !== intent.lineageId)
  )
    return null;
  return intent;
}

export const sameFailoverIntent = (a: UsageLimitFailoverIntent, b: UsageLimitFailoverIntent) =>
  a.type === b.type &&
  a.version === b.version &&
  a.sourceThreadId === b.sourceThreadId &&
  a.failedRunId === b.failedRunId &&
  a.failureItemId === b.failureItemId &&
  a.failureFingerprint === b.failureFingerprint &&
  a.policyRevision === b.policyRevision &&
  a.lineageId === b.lineageId &&
  modelSelectionsEqual(a.sourceSelection, b.sourceSelection) &&
  modelSelectionsEqual(a.destinationSelection, b.destinationSelection);
