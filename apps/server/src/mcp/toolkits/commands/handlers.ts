import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as BatchCommandRunner from "../../../commandRunner/BatchCommandRunner.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { CommandsToolkit } from "./tools.ts";

const handlers = {
  t3_run_commands: McpToolAccess.actsAsCaller(({ matchPatterns, ...input }) =>
    Effect.gen(function* () {
      const runner = yield* BatchCommandRunner.BatchCommandRunner;
      return yield* runner.run({ ...input, extraMatchPatterns: matchPatterns }).pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code:
                error._tag === "BatchCommandInputError" ? "invalid_request" : "orchestration_error",
              message: error.message,
            }),
        ),
      );
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof CommandsToolkit.tools>;

export const layer = McpToolAccess.toLayer(CommandsToolkit, handlers);
