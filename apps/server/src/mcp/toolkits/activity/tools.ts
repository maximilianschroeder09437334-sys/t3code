import { OrchestratorMcpFailure, WorkReportInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ActivityLedger from "../../../activity/ActivityLedger.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const WORK_REPORT_DESCRIPTION =
  "Record your thread's work status in the activity ledger the owner reads: progress, done, blocked, needs_you (the owner must act), or decision (a choice you made). `summary`: at most 3 lines and 400 characters. The report is always filed for your own thread.";

const WorkReportTool = Tool.make("t3_work_report", {
  description: WORK_REPORT_DESCRIPTION,
  parameters: WorkReportInput,
  success: Schema.Struct({ recorded: Schema.Boolean, eventId: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ActivityLedger.ActivityLedger,
  ],
});

export const ActivityToolkit = Toolkit.make(WorkReportTool);
