/*
 * Runs `t3_run_commands` batches hidden, one log file per batch, and returns a summary.
 * Invariant: no matched line or failing tail is dropped without the result saying so.
 */
// @effect-diagnostics nodeBuiltinImport:off -- Raw pipes stream into one log in arrival order.
// @effect-diagnostics globalTimers:off -- Timeout and pipe-close timers live in child callbacks.
// @effect-diagnostics globalTimersInEffect:off
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import { shouldExcludeTerminalEnvKey } from "../terminal/Manager.ts";
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
  /** Whole-batch limit, below the MCP call timeout so partial results still come back. */
  readonly maxBatchMs: number;
  /** Logs older than this, or past the newest `maxLogCount`, are deleted when a batch starts. */
  readonly maxLogAgeMs: number;
  readonly maxLogCount: number;
  readonly limits: OutputSummaryLimits;
}

export const DEFAULT_BATCH_COMMAND_RUNNER_CONFIG: Omit<BatchCommandRunnerConfig, "logsDir"> = {
  defaultTimeoutMs: 10 * 60_000,
  maxTimeoutMs: 60 * 60_000,
  pipeCloseGraceMs: 2_000,
  // Codex's T3 MCP timeout is 65 minutes.
  maxBatchMs: 60 * 60_000,
  maxLogAgeMs: 7 * 24 * 60 * 60_000,
  maxLogCount: 200,
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
  /** Something the shell started held the pipes open after it exited; later output is lost. */
  readonly outputCutAfterExit?: true;
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
  /** The batch ran out of `maxBatchMs`; the running command was killed and the rest skipped. */
  readonly batchTimedOut?: true;
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
      .on("exit", (code) => code === 0 || child.kill())
      .unref();
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
};

/** Windows ids are reused at once, so an exited shell's id may name another process. */
const killTreeIfRunning = (child: ChildProcess): void => {
  if (child.exitCode === null && child.signalCode === null) killTree(child);
};

const commandEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !shouldExcludeTerminalEnvKey(key)),
  );

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
    let outputCutAfterExit = false;
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const child = spawn(command, {
      cwd: options.cwd,
      env: commandEnv(),
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
      killTreeIfRunning(child);
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
          ...(outputCutAfterExit ? { outputCutAfterExit: true as const } : {}),
          durationMs: Math.round(performance.now() - startedAt),
          ...summarizer.finish(status !== "succeeded"),
        }),
      );
    };

    child.on("error", (error) => finish(null, null, error.message));
    child.on("exit", (code, signal) => {
      clearTimeout(timeoutTimer);
      graceTimer = setTimeout(() => {
        outputCutAfterExit = true;
        // POSIX group ids stay reserved while members live; a Windows id is not safe to reuse.
        if (!isWindows) killTree(child);
        finish(code, signal);
      }, options.config.pipeCloseGraceMs);
    });
    child.on("close", (code, signal) => finish(code, signal));

    return Effect.sync(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(graceTimer);
      killTreeIfRunning(child);
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
  if (!isAbsolute(input.cwd)) {
    return yield* new BatchCommandInputError({ message: `cwd must be absolute: ${input.cwd}` });
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
  return { timeoutMs, pattern: compileMatchPatterns(input.extraMatchPatterns) };
});

/** Best effort: a log another batch still writes or cannot be deleted stays. */
const pruneLogs = async (config: BatchCommandRunnerConfig, nowMs: number) => {
  const names = await readdir(config.logsDir).catch(() => []);
  const logs = await Promise.all(
    names
      .filter((name) => name.endsWith(".log"))
      .map((name) =>
        stat(join(config.logsDir, name)).then(
          (stats) => ({ name, modifiedMs: stats.mtimeMs }),
          () => undefined,
        ),
      ),
  );
  const newestFirst = logs
    .filter((log) => log !== undefined)
    .toSorted((a, b) => b.modifiedMs - a.modifiedMs);
  // Leave room for the log this batch is about to create.
  const stale = newestFirst.filter(
    (log, index) => index >= config.maxLogCount - 1 || nowMs - log.modifiedMs > config.maxLogAgeMs,
  );
  await Promise.all(
    stale.map((log) => rm(join(config.logsDir, log.name), { force: true }).catch(() => undefined)),
  );
};

const openLog = Effect.fnUntraced(function* (config: BatchCommandRunnerConfig) {
  const now = yield* DateTime.now;
  const nowMs = DateTime.toEpochMillis(now);
  const stamp = DateTime.formatIso(now).replace(/[:.]/g, "-");
  return yield* Effect.tryPromise({
    try: async () => {
      await mkdir(config.logsDir, { recursive: true });
      await pruneLogs(config, nowMs);
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
          const deadline = performance.now() + config.maxBatchMs;
          let stopped = false;
          let batchTimedOut = false;
          for (const command of input.commands) {
            const remainingMs = Math.floor(deadline - performance.now());
            if (!stopped && remainingMs <= 0) {
              batchTimedOut = true;
              stopped = true;
            }
            if (stopped) {
              results.push({ command, status: "skipped" });
              continue;
            }
            state.log.write(`$ ${command}\n`);
            const result = yield* runOne(command, {
              cwd: input.cwd,
              shell: input.shell,
              timeoutMs: Math.min(timeoutMs, remainingMs),
              pattern,
              config,
              log: state.log,
            });
            state.log.write(
              `\n[${result.status} exit=${result.exitCode ?? result.signal ?? "none"} ${result.durationMs}ms]\n\n`,
            );
            results.push(result);
            if (result.status === "timed_out" && remainingMs < timeoutMs) {
              batchTimedOut = true;
              stopped = true;
            }
            if (result.status !== "succeeded" && stopOnFailure) stopped = true;
          }
          yield* closeLog(state.log);
          return {
            ok: results.every((result) => result.status === "succeeded"),
            logPath: state.logPath,
            ...(state.error === undefined ? {} : { logError: state.error }),
            ...(batchTimedOut ? { batchTimedOut: true as const } : {}),
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
