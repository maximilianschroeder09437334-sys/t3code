import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ActivityLedger from "../../../activity/ActivityLedger.ts";
import * as NotionOutbox from "../../../activity/NotionOutbox.ts";
import { dailySummary } from "../../../activity/NotionMapping.ts";
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
      const rollupRows = yield* outbox
        .rollupsFallback(project, input.limit)
        .pipe(Effect.mapError(unavailable));
      const rollups = yield* Effect.forEach(rollupRows, (row) =>
        Effect.gen(function* () {
          const counts = yield* outbox
            .rollupCounts(project, row.day, row.through_sequence)
            .pipe(Effect.mapError(unavailable));
          const [latest] = yield* ledger
            .listAfter(row.through_sequence - 1, 1)
            .pipe(Effect.mapError(unavailable));
          if (latest?.sequence !== row.through_sequence)
            return yield* new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "The rollup event is unavailable.",
            });
          return {
            day: row.day,
            pageId: row.page_id,
            target: config?.dataSourceId ?? null,
            summary: dailySummary(counts),
            lastStep: latest.summary,
            nextStep: latest.next ?? "",
            throughSequence: row.through_sequence,
          };
        }),
      );
      return { items, rollups };
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
      if (
        (input.day === undefined) === (input.sequence === undefined) ||
        (input.day !== undefined &&
          (input.blockId !== undefined ||
            input.auxiliary === true ||
            input.throughSequence === undefined)) ||
        (input.sequence !== undefined && input.throughSequence !== undefined) ||
        (input.sequence !== undefined && input.auxiliary === true && input.blockId !== undefined) ||
        (input.sequence !== undefined && input.auxiliary !== true && input.blockId === undefined)
      )
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "Provide a day and pageId, an auxiliary sequence and pageId, or a sequence, pageId and blockId.",
        });
      const acknowledged =
        input.day !== undefined
          ? yield* outbox
              .ackRollup(project, input.day, input.pageId, input.throughSequence!)
              .pipe(Effect.mapError(unavailable))
          : input.auxiliary === true
            ? yield* outbox
                .ackAux(project, input.sequence!, input.pageId)
                .pipe(Effect.mapError(unavailable))
            : yield* outbox
                .ackForProject(
                  project,
                  input.sequence!,
                  config.dataSourceId,
                  input.pageId,
                  input.blockId!,
                )
                .pipe(Effect.mapError(unavailable));
      return { acknowledged };
    }),
  ),
});
