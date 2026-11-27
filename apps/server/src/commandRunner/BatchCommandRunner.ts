/*
 * Batch command runner behind the `t3_run_commands` MCP tool.
 * Agents read raw command output in full; this returns a summary and keeps the rest on disk.
 * - Commands run one after another in `cwd` through `shell` (Node's default when omitted:
 *   cmd.exe on Windows, /bin/sh elsewhere), never with a console window.
 * - Each command gets `timeoutMs`. A timeout or interruption kills its whole process tree.
 * - Every command's combined stdout and stderr, in arrival order, goes to one log file in
 *   `ServerConfig.commandLogsDir`, with a header and an exit line per command.
 * - Each result has the status, exit code, duration, line count and EVERY line matching the
 *   error/warning patterns (defaults plus caller additions, case-insensitive). Only past
 *   `maxMatchedLines` do matches stay in the log alone, and the result counts them.
 * - A failed command (non-zero exit, signal, timeout, spawn error) also returns its last lines.
 * - `stopOnFailure` (default true) skips the commands after a failure and lists them as skipped.
 * Invariant: no matched line and no failing tail is hidden without the result saying so.
 */
// @effect-diagnostics nodeBuiltinImport:off -- Raw pipes stream into one log in arrival order.
// @effect-diagnostics globalTimers:off -- Timeout and pipe-close timers live in child callbacks.
// @effect-diagnostics globalTimersInEffect:off
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import {
  compileMatchPatterns,
  DEFAULT_OUTPUT_SUMMARY_LIMITS,
  LineSplitter,
  OutputSummarizer,
  type CommandOutputSummary,
  type OutputSummaryLimits,
} from "./summarizeCommandOutput.ts";

export interface BatchCommandRunnerConfig {
  readonly logsDir: string;
  readonly defaultTimeoutMs: number;
  readonly maxTimeoutMs: number;
  /** How long to wait for output pipes after the shell exits, as when a child outlives it. */
  readonly pipeCloseGraceMs: number;
  readonly limits: OutputSummaryLimits;
}

export const DEFAULT_BATCH_COMMAND_RUNNER_CONFIG: Omit<BatchCommandRunnerConfig, "logsDir"> = {
  defaultTimeoutMs: 10 * 60_000,
  maxTimeoutMs: 60 * 60_000,
  pipeCloseGraceMs: 2_000,
  limits: DEFAULT_OUTPUT_SUMMARY_LIMITS,
};

export interface BatchCommandRunInput {
  readonly commands: ReadonlyArray<string>;
  readonly cwd: string;
  readonly timeoutMs?: number | undefined;
  readonly stopOnFailure?: boolean | undefined;
  readonly shell?: string | undefined;
  readonly extraMatchPatterns?: ReadonlyArray<string> | undefined;
}

export type CommandRunStatus = "succeeded" | "failed" | "timed_out" | "spawn_failed";

export interface CommandRunResult extends CommandOutputSummary {
  readonly command: string;
  readonly status: CommandRunStatus;
  readonly exitCode: number | null;
  readonly signal?: string;
  readonly spawnError?: string;
  readonly durationMs: number;
}

export interface SkippedCommand {
  readonly command: string;
  readonly status: "skipped";
}

export interface BatchCommandRunResult {
  readonly ok: boolean;
  readonly logPath: string;
  /** Set when the log could not be fully written; the summaries are still complete. */
  readonly logError?: string;
  readonly commands: ReadonlyArray<CommandRunResult | SkippedCommand>;
}

export class BatchCommandInputError extends Schema.TaggedError<BatchCommandInputError>()(
  "BatchCommandInputError",
  { message: Schema.String },
) {}

export class BatchCommandLogError extends Schema.TaggedError<BatchCommandLogError>()(
  "BatchCommandLogError",
  { message: Schema.String, cause: Schema.Defect() },
) {}

export class BatchCommandRunner extends Context.Service<
  BatchCommandRunner,
  {
    readonly run: (
      input: BatchCommandRunInput,
    ) => Effect.Effect<BatchCommandRunResult, BatchCommandInputError | BatchCommandLogError>;
  }
>()("t3/commandRunner/BatchCommandRunner") {}

const isWindows = process.platform === "win32";

/** Ends the command and everything it started. POSIX children lead their own process group. */
const killTree = (child: ChildProcess): void => {
  const pid = child.pid;
  if (pid === undefined) return;
  if (isWindows) {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
      .on("error", () => child.kill())
      .unref();
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
};

const runOne = (
  command: string,
  options: {
    readonly cwd: string;
    readonly shell: string | undefined;
    readonly timeoutMs: number;
    readonly pattern: RegExp;
    readonly config: BatchCommandRunnerConfig;
    readonly log: WriteStream;
  },
) =>
  Effect.callback<CommandRunResult>((resume) => {
    const startedAt = performance.now();
    const summarizer = new OutputSummarizer(options.pattern, options.config.limits);
    let timedOut = false;
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const child = spawn(command, {
      cwd: options.cwd,
      shell: options.shell ?? true,
      windowsHide: true,
      // On Windows a detached child gets its own console window.
      detached: !isWindows,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const streams = [child.stdout, child.stderr].map((stream) => {
      const decoder = new StringDecoder("utf8");
      const splitter = new LineSplitter();
      stream.on("data", (chunk: Buffer) => {
        options.log.write(chunk);
        for (const line of splitter.push(decoder.write(chunk))) summarizer.addLine(line);
      });
      return () => {
        for (const line of splitter.push(decoder.end())) summarizer.addLine(line);
        for (const line of splitter.flush()) summarizer.addLine(line);
      };
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, options.timeoutMs);

    const finish = (exitCode: number | null, signal: string | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(graceTimer);
      child.stdout.destroy();
      child.stderr.destroy();
      for (const flush of streams) flush();
      const status: CommandRunStatus =
        spawnError !== undefined
          ? "spawn_failed"
          : timedOut
            ? "timed_out"
            : exitCode === 0
              ? "succeeded"
              : "failed";
      resume(
        Effect.succeed({
          command,
          status,
          exitCode,
          ...(signal === null ? {} : { signal }),
          ...(spawnError === undefined ? {} : { spawnError }),
          durationMs: Math.round(performance.now() - startedAt),
          ...summarizer.finish(status !== "succeeded"),
        }),
      );
    };

    child.on("error", (error) => finish(null, null, error.message));
    child.on("exit", (code, signal) => {
      graceTimer = setTimeout(() => finish(code, signal), options.config.pipeCloseGraceMs);
    });
    child.on("close", (code, signal) => finish(code, signal));

    return Effect.sync(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(graceTimer);
      killTree(child);
    });
  });

const validate = Effect.fnUntraced(function* (
  input: BatchCommandRunInput,
  config: BatchCommandRunnerConfig,
) {
  if (input.commands.length === 0) {
    return yield* new BatchCommandInputError({ message: "Pass at least one command." });
  }
  const timeoutMs = input.timeoutMs ?? config.defaultTimeoutMs;
  if (!(timeoutMs > 0 && timeoutMs <= config.maxTimeoutMs)) {
    return yield* new BatchCommandInputError({
      message: `timeoutMs must be between 1 and ${config.maxTimeoutMs}.`,
    });
  }
  const isDirectory = yield* Effect.promise(() =>
    stat(input.cwd).then(
      (stats) => stats.isDirectory(),
      () => false,
    ),
  );
  if (!isDirectory) {
    return yield* new BatchCommandInputError({ message: `cwd is not a directory: ${input.cwd}` });
  }
  const pattern = yield* Effect.try({
    try: () => compileMatchPatterns(input.extraMatchPatterns),
    catch: (cause) =>
      new BatchCommandInputError({ message: `Invalid match pattern: ${String(cause)}` }),
  });
  return { timeoutMs, pattern };
});

const openLog = Effect.fnUntraced(function* (config: BatchCommandRunnerConfig) {
  const stamp = DateTime.formatIso(yield* DateTime.now).replace(/[:.]/g, "-");
  return yield* Effect.tryPromise({
    try: async () => {
      await mkdir(config.logsDir, { recursive: true });
      const logPath = join(config.logsDir, `${stamp}-${randomUUID().slice(0, 8)}.log`);
      const log = createWriteStream(logPath, { flags: "wx" });
      await new Promise<void>((resolve, reject) => {
        log.once("open", () => resolve());
        log.once("error", reject);
      });
      const state = { logPath, log, error: undefined as string | undefined };
      log.on("error", (error) => {
        state.error ??= error.message;
      });
      return state;
    },
    catch: (cause) =>
      new BatchCommandLogError({ message: "Could not create the command log.", cause }),
  });
});

const closeLog = (log: WriteStream) =>
  Effect.callback<void>((resume) => {
    log.end(() => resume(Effect.void));
  });

export const make = (config: BatchCommandRunnerConfig): BatchCommandRunner["Service"] => ({
  run: Effect.fn("BatchCommandRunner.run")(function* (input) {
    const { timeoutMs, pattern } = yield* validate(input, config);
    const stopOnFailure = input.stopOnFailure ?? true;
    return yield* Effect.acquireUseRelease(
      openLog(config),
      (state) =>
        Effect.gen(function* () {
          const results: Array<CommandRunResult | SkippedCommand> = [];
          let stopped = false;
          for (const command of input.commands) {
            if (stopped) {
              results.push({ command, status: "skipped" });
              continue;
            }
            state.log.write(`$ ${command}\n`);
            const result = yield* runOne(command, {
              cwd: input.cwd,
              shell: input.shell,
              timeoutMs,
              pattern,
              config,
              log: state.log,
            });
            state.log.write(
              `\n[${result.status} exit=${result.exitCode ?? result.signal ?? "none"} ${result.durationMs}ms]\n\n`,
            );
            results.push(result);
            if (result.status !== "succeeded" && stopOnFailure) stopped = true;
          }
          yield* closeLog(state.log);
          return {
            ok: results.every((result) => result.status === "succeeded"),
            logPath: state.logPath,
            ...(state.error === undefined ? {} : { logError: state.error }),
            commands: results,
          } satisfies BatchCommandRunResult;
        }),
      // Reached with the log still open only on failure or interruption.
      (state) => Effect.sync(() => state.log.writableEnded || state.log.end()),
    );
  }),
});

export const layer = Layer.effect(
  BatchCommandRunner,
  Effect.gen(function* () {
    const { commandLogsDir } = yield* ServerConfig;
    return make({ ...DEFAULT_BATCH_COMMAND_RUNNER_CONFIG, logsDir: commandLogsDir });
  }),
);
