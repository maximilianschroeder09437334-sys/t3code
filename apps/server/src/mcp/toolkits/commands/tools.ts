import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as BatchCommandRunner from "../../../commandRunner/BatchCommandRunner.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const CommandResult = Schema.Struct({
  command: Schema.String,
  status: Schema.Literals(["succeeded", "failed", "timed_out", "spawn_failed", "skipped"]),
  exitCode: Schema.optional(Schema.NullOr(Schema.Int)),
  signal: Schema.optional(Schema.String),
  spawnError: Schema.optional(Schema.String),
  durationMs: Schema.optional(Count),
  lineCount: Schema.optional(Count),
  matchedLineCount: Schema.optional(Count),
  matchedLines: Schema.optional(Schema.Array(Schema.Struct({ line: Count, text: Schema.String }))),
  matchedLinesInLogOnly: Schema.optional(Count),
  tail: Schema.optional(Schema.Array(Schema.String)),
});

const RunCommandsTool = Tool.make("t3_run_commands", {
  description:
    "Run shell commands one after another, hidden, and get a summary instead of their output: per command status, exit code, duration, line count, every error/warning line, and the last lines of a failed one. The full output goes to `logPath`. Use for builds, tests, installs and other long output.",
  parameters: Schema.Struct({
    commands: Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(50),
    ),
    cwd: Schema.String.annotate({ description: "Absolute directory." }),
    timeoutMs: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
      description: "Per command. Default 10 minutes. Kills the process tree.",
    }),
    stopOnFailure: Schema.optional(Schema.Boolean).annotate({
      description: "Skip the rest after a failure. Default true.",
    }),
    shell: Schema.optional(Schema.String).annotate({
      description:
        "Shell executable, such as bash or pwsh. Default cmd.exe on Windows, sh elsewhere.",
    }),
    matchPatterns: Schema.optional(Schema.Array(Schema.String)).annotate({
      description: "Extra case-insensitive regexes for lines to keep, beside error/warning ones.",
    }),
  }),
  success: Schema.Struct({
    ok: Schema.Boolean,
    logPath: Schema.String,
    logError: Schema.optional(Schema.String),
    commands: Schema.Array(CommandResult),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    BatchCommandRunner.BatchCommandRunner,
  ],
})
  .annotate(Tool.Title, "Run commands with a summarised result")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const CommandsToolkit = Toolkit.make(RunCommandsTool);
