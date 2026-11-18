import * as Receipts from "./CommandReceiptStore.ts";
import { isContextRolloverLimitNotice } from "./ContextRollover.ts";
import {
  CommandId,
  HandoffInput,
  type HandoffRequest,
  OrchestratorMcpFailure,
  ThreadId,
  RuntimeRequestId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { derive } from "@t3tools/provider-core/server/IdAllocator";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  handoffParkRecoveryCommand,
  handoffRecoveryCommand,
  handoffStartEffectId,
  withTransferReleaseAuthority,
} from "./HandoffTransferAdmission.ts";
import * as ActivityLedger from "../activity/ActivityLedger.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";

const decodeHandoff = Schema.decodeEffect(HandoffInput);
const encodeHandoff = Schema.encodeEffect(Schema.fromJsonString(HandoffInput));
const refuse = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
export const handoffId = (id: ThreadId) => `core-handoff:${id}`;

const activeCommand = (item: OrchestrationV2TurnItem) =>
  item.type === "command_execution" && ["pending", "running", "waiting"].includes(item.status);

export function contextLimitWorkBarrier(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  proof: HandoffInput["contextLimitWork"],
) {
  const cap = items.findLast(
    (item) =>
      item.type === "system_notice" &&
      item.runId !== null &&
      (isContextRolloverLimitNotice(item.id) ||
        item.id === derive.runSignalTurnItem({ runId: item.runId, signal: "hook-context-limit" }) ||
        (item.id ===
          derive.runSignalTurnItem({ runId: item.runId, signal: "hook-continuation-paused" }) &&
          item.message.startsWith("This native session reached 250,000 context tokens."))),
  );
  if (cap === undefined) return null;
  const active = items.find(activeCommand);
  if (active !== undefined)
    return { blocker: `Command ${active.id} is still active at the context limit.` };
  if (proof === undefined || proof.capRunId !== cap.runId)
    return {
      blocker:
        "Confirm foreground, background and detached work and include its saved results for the context-limit run.",
    };
  const captured = new Set(proof.results.map((result) => result.commandItemId));
  const missing = items.find(
    (item) =>
      item.type === "command_execution" &&
      item.completedAt !== null &&
      DateTime.Order(item.completedAt, cap.updatedAt) >= 0 &&
      (item.startedAt === null || DateTime.Order(item.startedAt, cap.updatedAt) <= 0) &&
      !captured.has(item.id),
  );
  return {
    blocker:
      missing === undefined
        ? null
        : `Include the saved result of command ${missing.id} before rotating at the context limit.`,
  };
}

/** The first request wins for a source thread, even if competing submissions have different text. */
export const submitHandoff = Effect.fn("CoreHandoff.submit")(function* (
  sourceThreadId: ThreadId,
  input: HandoffInput,
) {
  const handoff = yield* decodeHandoff(input).pipe(
    Effect.mapError(() =>
      refuse("Invalid handoff; the complete payload must fit in 6000 characters."),
    ),
  );
  const threads = yield* ThreadManagement.ThreadManagementService;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const { thread, turnItems } = yield* threads.getThreadRecords(sourceThreadId, ["turnItems"]);
  if (
    thread.deletedAt !== null ||
    thread.agentExecutionIntent?.restrictedTools !== undefined ||
    thread.linkOrigin !== undefined
  )
    return yield* refuse("This source thread cannot submit a local core handoff.");
  if (thread.branch === null || thread.branch !== handoff.state.branch)
    return yield* refuse("The handoff branch must match the source thread's known branch.");
  const barrier = contextLimitWorkBarrier(turnItems, handoff.contextLimitWork);
  if (barrier?.blocker) return yield* refuse(barrier.blocker);
  const id = handoffId(sourceThreadId);
  const request: HandoffRequest = {
    type: "thread.handoff",
    handoff,
    projectId: thread.projectId,
    sourceThreadId,
    successorThreadId: ThreadId.make(`${id}:successor`),
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    worktreePath: thread.worktreePath,
    branch: thread.branch,
  };
  yield* outbox.enqueue([{ id, commandId: CommandId.make(id), threadId: sourceThreadId, request }]);
  const accepted = yield* outbox.get(id);
  if (Option.isNone(accepted) || accepted.value.request.type !== "thread.handoff")
    return yield* refuse("The durable handoff request could not be confirmed.");
  if ((yield* encodeHandoff(accepted.value.request.handoff)) !== (yield* encodeHandoff(handoff)))
    return yield* refuse(
      "This source already has a different durable handoff; the first request is preserved.",
    );
  yield* outbox.notifyAvailable();
  return {
    accepted: true,
    successorThreadId: accepted.value.request.successorThreadId,
    sourceRetained: true,
    status: "awaiting_transfer" as const,
  };
});

export class HandoffParked extends Schema.TaggedError<HandoffParked>()("HandoffParked", {
  message: Schema.String,
}) {}

export const recoverReleasedHandoff = Effect.fn("CoreHandoff.recoverReleased")(function* (
  sourceId: ThreadId,
  threads: ThreadManagement.ThreadManagementService["Service"],
  outbox: EffectOutbox.EffectOutboxV2["Service"],
) {
  const pair = (yield* threads.getThreadRecords(sourceId, [])).thread.handoffTransfer;
  if (pair?.state !== "released" || pair.parkedRecovery !== undefined) return;
  const previous = yield* outbox.get(handoffStartEffectId(pair));
  if (
    Option.isNone(previous) ||
    previous.value.status !== "cancelled" ||
    previous.value.lastError !== EffectOutbox.HANDOFF_PROCESS_LOSS_REASON
  )
    return;
  const count = pair.recoveryCount ?? 0;
  if (count >= 2)
    return yield* new HandoffParked({
      message: "Bounded handoff recovery exhausted; source fence retained for explicit reversal.",
    });
  const command = {
    type: "handoff.transfer.recover" as const,
    commandId: handoffRecoveryCommand(pair, count + 1),
    threadId: sourceId,
    requestId: pair.requestId,
    generation: pair.generation,
  };
  yield* threads.dispatch(command).pipe(
    // The normal recovery refusal may already have a receipt from an earlier startup.
    // Publishing the exact parked outcome has its own idempotency key.
    Effect.catch((cause) =>
      count === 0
        ? Effect.fail(cause)
        : threads
            .dispatch({ ...command, commandId: handoffParkRecoveryCommand(pair) })
            .pipe(Effect.mapError(() => cause)),
    ),
  );
});

/** Accepted reviews prepare and release one fenced pair; legacy receipts reconcile without new launch authority. */
export const deliverHandoff = Effect.fn("CoreHandoff.deliver")(function* (request: HandoffRequest) {
  const launches = yield* Effect.serviceOption(ThreadLaunch.ThreadLaunchService);
  const receipts = yield* Effect.serviceOption(Receipts.CommandReceiptStoreV2);
  if (Option.isNone(launches) && Option.isNone(receipts))
    return yield* new HandoffParked({
      message: "Durable receipt owner unavailable; source retained.",
    });
  const lookupReceipt = Option.isSome(launches)
    ? launches.value.lookupCommandReceipt
    : Option.getOrThrow(receipts).getByCommandId;
  const commandId = CommandId.make(`${handoffId(request.sourceThreadId)}:launch`);
  const threads = yield* ThreadManagement.ThreadManagementService;
  const sourceRecords = yield* threads.getThreadRecords(request.sourceThreadId, [
    "runtimeRequests",
  ]);
  if (sourceRecords.thread.handoffStopCommandId !== undefined)
    return yield* new HandoffParked({
      message: "Handoff explicitly stopped; no automatic revival is permitted.",
    });
  const decision = sourceRecords.runtimeRequests.findLast(
    (item) =>
      item.status === "resolved" &&
      item.decision === "accept" &&
      item.responseCapability.type === "handoff" &&
      item.responseCapability.successorThreadId === request.successorThreadId &&
      item.responseCapability.releaseEvidence !== undefined,
  );
  if (decision?.responseCapability.type === "handoff") {
    const review = decision.responseCapability;
    const prepareId = CommandId.make(`handoff-transfer:${review.requestId}:prepare`);
    const preparedReceipt = yield* lookupReceipt(prepareId);
    if (Option.isNone(preparedReceipt))
      yield* threads.dispatch({
        type: "handoff.transfer.prepare",
        commandId: prepareId,
        threadId: request.sourceThreadId,
        requestId: review.requestId,
        generation: review.generation,
      });
    else if (
      preparedReceipt.value.status !== "accepted" ||
      preparedReceipt.value.commandType !== "handoff.transfer.prepare" ||
      preparedReceipt.value.threadId !== request.sourceThreadId
    )
      return yield* new HandoffParked({
        message: "Transfer preparation receipt rejected or mismatched; source retained.",
      });
    const source = (yield* threads.getThreadRecords(request.sourceThreadId, [])).thread;
    const pair = source.handoffTransfer;
    if (!pair || pair.requestId !== review.requestId || pair.state === "cancelled")
      return yield* new HandoffParked({
        message: "Transfer cancelled or reservation missing; source retained.",
      });
    yield* withTransferReleaseAuthority(
      threads.dispatch({
        type: "prepared-run.release",
        commandId: CommandId.make(`handoff-transfer:${review.requestId}:release`),
        threadId: pair.successorThreadId,
        runId: pair.runId,
      }),
    ).pipe(
      Effect.onError(() =>
        threads
          .dispatch({
            type: "handoff.transfer.cancel",
            commandId: CommandId.make(`handoff-transfer:${review.requestId}:cancel`),
            threadId: request.sourceThreadId,
            requestId: RuntimeRequestId.make(review.requestId),
            generation: review.generation,
          })
          .pipe(Effect.catchCause(() => Effect.void)),
      ),
    );
    const owner = yield* Effect.serviceOption(EffectOutbox.EffectOutboxV2);
    if (Option.isSome(owner))
      yield* recoverReleasedHandoff(request.sourceThreadId, threads, owner.value);
    else if (
      (yield* threads.getThreadRecords(request.sourceThreadId, [])).thread.handoffTransfer
        ?.state === "released"
    )
      return yield* new HandoffParked({
        message: "Durable outbox owner unavailable; transfer fence retained.",
      });
    const ledger = yield* ActivityLedger.ActivityLedger;
    yield* ledger.append({
      key: `${handoffId(request.sourceThreadId)}:confirmed`,
      kind: "handoff",
      projectId: request.projectId,
      threadId: request.sourceThreadId,
      summary:
        "Guarded handoff released one reserved successor; provider admission and reversal remain authoritative.",
      links: {
        sourceThreadId: request.sourceThreadId,
        successorThreadId: request.successorThreadId,
      },
    });
    return;
  }
  const receipt = yield* lookupReceipt(commandId);
  if (Option.isNone(receipt))
    return yield* new HandoffParked({
      message:
        "Awaiting transfer: no authoritative atomic source/workspace transfer proof; source retained.",
    });
  if (
    receipt.value.status !== "accepted" ||
    receipt.value.commandType !== "thread.create" ||
    receipt.value.threadId !== request.successorThreadId
  )
    return yield* new HandoffParked({
      message: "Awaiting transfer: prior launch receipt rejected or mismatched; source retained.",
    });
  const projection = yield* threads.getThreadProjection(request.successorThreadId);
  const text = yield* encodeHandoff(request.handoff);
  const successor = projection.thread;
  if (
    successor.id !== request.successorThreadId ||
    successor.projectId !== request.projectId ||
    successor.branch !== request.branch ||
    successor.worktreePath !== request.worktreePath ||
    !modelSelectionsEqual(successor.modelSelection, request.modelSelection) ||
    successor.runtimeMode !== request.runtimeMode ||
    successor.interactionMode !== request.interactionMode ||
    projection.messages[0]?.text !== text
  )
    return yield* new HandoffParked({
      message:
        "Awaiting transfer: successor acknowledgement does not match the durable handoff; source retained.",
    });
  const ledger = yield* ActivityLedger.ActivityLedger;
  yield* ledger.append({
    key: `${handoffId(request.sourceThreadId)}:confirmed`,
    kind: "handoff",
    projectId: request.projectId,
    threadId: request.sourceThreadId,
    summary: "Earlier successor delivery reconciled; source retained, ownership transfer unproven.",
    links: { sourceThreadId: request.sourceThreadId, successorThreadId: request.successorThreadId },
  });
});
