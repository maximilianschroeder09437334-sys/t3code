import {
  OrchestratorMcpFailure,
  type ProjectId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HookAutomation from "./HookAutomation.ts";

export const runHookedHandoff = Effect.fn("HookHandoffGateway.run")(function* <A, E, R>(
  owner: { readonly projectId: ProjectId; readonly threadId: ThreadId; readonly runId: RunId },
  payload: unknown,
  delivery: Effect.Effect<A, E, R>,
) {
  const automation = yield* HookAutomation.HookAutomation;
  const decision = yield* automation.emit(owner, "before_handoff", payload).pipe(
    Effect.mapError(
      () =>
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "The handoff safeguard could not run.",
        }),
    ),
  );
  if (!decision.allowed)
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: decision.messages.join("\n") || "An approved hook blocked this handoff.",
    });
  const receipt = yield* delivery;
  // A failed observer must never make an already delivered handoff look unsent.
  yield* automation.emit(owner, "handoff_completed", { request: payload, receipt }).pipe(
    Effect.catchCause(() =>
      Effect.logWarning("Handoff delivered; its hook receipt could not be recorded", {
        threadId: owner.threadId,
      }),
    ),
  );
  return receipt;
});
