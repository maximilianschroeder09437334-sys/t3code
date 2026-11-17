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
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});
const Ack = Tool.make("t3_notion_outbox_ack", {
  description:
    "Acknowledge a reconciled item after confirming its Notion page and event block exist.",
  parameters: Schema.Struct({
    sequence: Schema.Int.check(Schema.isGreaterThan(0)),
    pageId: Schema.String.check(Schema.isMinLength(1)),
    blockId: Schema.String.check(Schema.isMinLength(1)),
  }),
  success: Schema.Struct({ acknowledged: Schema.Boolean }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});
export const NotionOutboxToolkit = Toolkit.make(List, Ack);
