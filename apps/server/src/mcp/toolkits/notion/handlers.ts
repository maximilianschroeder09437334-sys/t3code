import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ActivityLedger from "../../../activity/ActivityLedger.ts";
import * as NotionOutbox from "../../../activity/NotionOutbox.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { NotionOutboxToolkit } from "./tools.ts";

const callerProject = Effect.fn("NotionOutboxMcp.callerProject")(function* () {
  const { caller } = yield* readCaller();
  if (caller === undefined)
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "An active agent thread is required.",
    });
  return caller.projectId;
});
export const layer = McpToolAccess.toLayer(NotionOutboxToolkit, {
  t3_notion_outbox_list: McpToolAccess.writesThreadScoped((input) =>
    Effect.gen(function* () {
      const project = yield* callerProject();
      const outbox = yield* NotionOutbox.NotionOutbox;
      const ledger = yield* ActivityLedger.ActivityLedger;
      const settings = yield* ServerSettings.ServerSettingsService;
      const config = (yield* settings.getSettings.pipe(Effect.mapError(unavailable))).notionSync
        ?.projects[project];
      const rows = yield* outbox
        .fallbackForProject(project, input.limit)
        .pipe(Effect.mapError(unavailable));
      const items = yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const [event] = yield* ledger
            .listAfter(row.event_sequence - 1, 1)
            .pipe(Effect.mapError(unavailable));
          if (event?.sequence !== row.event_sequence)
            return yield* new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "The outbox event is unavailable.",
            });
          return {
            event,
            pageId: row.page_id,
            reason: row.last_error,
            target: config?.dataSourceId ?? null,
          };
        }),
      );
      return { items };
    }),
  ),
  t3_notion_outbox_ack: McpToolAccess.writesThreadScoped((input) =>
    Effect.gen(function* () {
      const project = yield* callerProject();
      const outbox = yield* NotionOutbox.NotionOutbox;
      const settings = yield* ServerSettings.ServerSettingsService;
      const config = (yield* settings.getSettings.pipe(Effect.mapError(unavailable))).notionSync
        ?.projects[project];
      if (!config?.dataSourceId)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Configure the target data source first.",
        });
      return {
        acknowledged: yield* outbox
          .ackForProject(project, input.sequence, config.dataSourceId, input.pageId, input.blockId)
          .pipe(Effect.mapError(unavailable)),
      };
    }),
  ),
});
