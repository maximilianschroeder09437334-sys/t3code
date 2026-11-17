// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ActivityLedger from "../../../activity/ActivityLedger.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { ActivityToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(ActivityToolkit, {
  t3_work_report: McpToolAccess.writesThreadScoped((input) =>
    Effect.gen(function* () {
      // Thread and project come from the authenticated caller, never from tool input.
      const { caller, threads } = yield* readCaller();
      if (caller === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "An active agent thread is required.",
        });
      const { runs } = yield* threads
        .getThreadRecords(caller.id, ["runs"])
        .pipe(Effect.mapError(unavailable));
      // A retried call in the same run is the same report.
      const key = `report:${caller.id}:${runs.at(-1)?.id ?? "none"}:${NodeCrypto.createHash(
        "sha256",
      )
        .update(`${input.status}
${input.summary}`)
        .digest("hex")}`;
      const ledger = yield* ActivityLedger.ActivityLedger;
      const { event } = yield* ledger
        .append({
          key,
          kind: input.status,
          projectId: caller.projectId,
          threadId: caller.id,
          summary: input.summary,
          ...(input.featureKey === undefined ? {} : { featureKey: input.featureKey }),
          ...(input.commits === undefined ? {} : { links: { commits: input.commits } }),
          ...(input.next === undefined ? {} : { next: input.next }),
          ...(input.tests === undefined ? {} : { tests: input.tests }),
        })
        .pipe(Effect.mapError(unavailable));
      return { recorded: true, eventId: event.id };
    }),
  ),
});
