import { automaticHandoffDeclaration } from "@t3tools/contracts";
import {
  CommandId,
  RuntimeRequestId,
  type ThreadId,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import { queryHandoffReadiness } from "./CoreHandoffReadiness.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";
export const requestHandoffApproval = Effect.fn("HandoffApproval.request")(function* (
  sourceThreadId: ThreadId,
  expectedGeneration: string,
  mode: "manual" | "automatic" = "manual",
) {
  const snapshot = yield* queryHandoffReadiness(sourceThreadId, expectedGeneration);
  const parked = snapshot.after.parkedRequest;
  const source = snapshot.after.sourceRecords?.thread;
  if (
    !snapshot.stable ||
    !snapshot.expectedGenerationMatches ||
    snapshot.classification !==
      (mode === "automatic" ? "automatically_eligible" : "manual_review") ||
    !parked ||
    !source ||
    source.id !== parked.sourceThreadId ||
    source.projectId !== parked.projectId ||
    source.branch !== parked.branch ||
    source.worktreePath !== parked.worktreePath ||
    !modelSelectionsEqual(source.modelSelection, parked.modelSelection) ||
    source.runtimeMode !== parked.runtimeMode ||
    source.interactionMode !== parked.interactionMode ||
    snapshot.before.blockers.length ||
    snapshot.after.blockers.length ||
    snapshot.before.unknowns.length ||
    snapshot.after.unknowns.length ||
    snapshot.after.sourceSequence === null ||
    snapshot.after.children.some((child) => child.sequence === null)
  ) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "A stable, otherwise ready handoff generation of the requested kind is required.",
    });
  }
  const requestId = RuntimeRequestId.make(
    `handoff-review:${sourceThreadId}:${snapshot.generation}`,
  );
  const threads = yield* ThreadManagementService;
  const result = yield* threads.dispatch({
    type: "handoff.approval.record",
    commandId: CommandId.make(requestId),
    threadId: sourceThreadId,
    review: {
      type: "handoff",
      releaseEvidence: snapshot.releaseEvidence,
      requestId,
      sourceThreadId,
      successorThreadId: parked.successorThreadId,
      generation: snapshot.generation,
      declaration:
        mode === "automatic"
          ? automaticHandoffDeclaration
          : "I reviewed native and detached work manually. This supplies only manual coverage; guarded transfer must still revalidate all app-owned work.",
      blockers: [],
      unknowns: [],
      manualReview: snapshot.after.manualReview,
      sourceSequence: snapshot.after.sourceSequence,
      children: snapshot.after.children.map((child) => ({
        id: child.id,
        sequence: child.sequence!,
      })),
    },
  });
  return {
    requestId,
    generation: snapshot.generation,
    successorThreadId: parked.successorThreadId,
    status: "awaiting_review" as const,
    transferAuthorized: false as const,
    sequence: result.sequence,
  };
});
