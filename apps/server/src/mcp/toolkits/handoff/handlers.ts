import {
  queryHandoffReadiness,
  summarizeHandoffReadiness,
} from "../../../orchestration-v2/CoreHandoffReadiness.ts";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { submitHandoff } from "../../../orchestration-v2/CoreHandoff.ts";
import { requestHandoffApproval } from "../../../orchestration-v2/HandoffApproval.ts";
import { HandoffToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(HandoffToolkit, {
  t3_handoff_request_approval: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { caller, scope } = yield* readCaller();
      if (caller === undefined || scope.thread?.subagent === true)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "An authenticated source thread is required.",
        });
      return yield* requestHandoffApproval(caller.id, input.expectedGeneration).pipe(
        Effect.mapError((error) =>
          error._tag === "OrchestratorMcpFailure" ? error : unavailable(),
        ),
      );
    }),
  ),
  t3_handoff_readiness: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { caller, scope } = yield* readCaller();
      if (caller === undefined || scope.thread?.subagent === true)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "An authenticated source thread is required.",
        });
      return yield* queryHandoffReadiness(caller.id, input.expectedGeneration).pipe(
        Effect.map(summarizeHandoffReadiness),
        Effect.mapError(() => unavailable()),
      );
    }),
  ),
  t3_handoff_submit: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { caller, scope } = yield* readCaller();
      if (caller === undefined || scope.thread?.subagent === true)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "An authenticated source thread is required.",
        });
      return yield* submitHandoff(caller.id, input).pipe(
        Effect.mapError((error) =>
          error._tag === "OrchestratorMcpFailure" ? error : unavailable(),
        ),
      );
    }),
  ),
});
