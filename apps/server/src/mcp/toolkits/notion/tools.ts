import { ActivityEvent, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ActivityLedger from "../../../activity/ActivityLedger.ts";
import * as NotionOutbox from "../../../activity/NotionOutbox.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagement.ThreadManagementService,
  ActivityLedger.ActivityLedger,
  NotionOutbox.NotionOutbox,
  ServerSettings.ServerSettingsService,
];
const List = Tool.make("t3_notion_outbox_list", {
  description: "List this project's Notion sync items needing reconciliation.",
  parameters: Schema.Struct({
    limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  }),
  success: Schema.Struct({
    items: Schema.Array(
      Schema.Struct({
        event: ActivityEvent,
        pageId: Schema.NullOr(Schema.String),
        reason: Schema.NullOr(Schema.String),
        target: Schema.NullOr(Schema.String),
      }),
    ),
    rollups: Schema.Array(
      Schema.Struct({
        day: Schema.String,
        pageId: Schema.NullOr(Schema.String),
        target: Schema.NullOr(Schema.String),
        summary: Schema.String,
        lastStep: Schema.String,
        nextStep: Schema.String,
        throughSequence: Schema.Int,
      }),
    ),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});
const Ack = Tool.make("t3_notion_outbox_ack", {
  description:
    "Confirm a reconciled event with sequence, pageId and blockId; an auxiliary week/day/topic with sequence, pageId and auxiliary=true; or a completed daily rollup with day, pageId and the listed throughSequence. Preserve existing content.",
  parameters: Schema.Struct({
    sequence: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
    day: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))),
    pageId: Schema.String.check(Schema.isMinLength(1)),
    blockId: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
    auxiliary: Schema.optionalKey(Schema.Boolean),
    throughSequence: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  }),
  success: Schema.Struct({ acknowledged: Schema.Boolean }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});
export const NotionOutboxToolkit = Toolkit.make(List, Ack);
