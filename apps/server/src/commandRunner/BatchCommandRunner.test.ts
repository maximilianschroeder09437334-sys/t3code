// @effect-diagnostics nodeBuiltinImport:off processEnvInEffect:off - Real subprocess fixtures need real temp files and the live environment.
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as BatchCommandRunner from "./BatchCommandRunner.ts";

const node = (script: string) => `"${process.execPath}" "${script}"`;

const withFixture = <A, E>(
  use: (fixture: {
    readonly dir: string;
    readonly runner: BatchCommandRunner.BatchCommandRunner["Service"];
    readonly script: (name: string, source: string) => Effect.Effect<string>;
  }) => Effect.Effect<A, E>,
  overrides: Partial<BatchCommandRunner.BatchCommandRunnerConfig> = {},
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "t3-batch-commands-"))),
    (dir) =>
      use({
        dir,
        runner: BatchCommandRunner.make({
          ...BatchCommandRunner.DEFAULT_BATCH_COMMAND_RUNNER_CONFIG,
          logsDir: join(dir, "logs"),
          // Large, so a run only finishes early when the killed tree really closed its pipes.
          pipeCloseGraceMs: 60_000,
          ...overrides,
        }),
        script: (name, source) =>
          Effect.promise(async () => {
            const path = join(dir, name);
            await writeFile(path, source);
            return path;
          }),
      }),
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
  );

it.live("summarises a failing command, keeps its full output in the log and skips the rest", () =>
  withFixture(({ dir, runner, script }) =>
    Effect.gen(function* () {
      const failing = yield* script(
        "fail.cjs",
        [
          "for (let i = 1; i <= 200; i++) console.log('line ' + i);",
          "console.error('Warning: disk almost full');",
          "console.error('Error: boom');",
          "console.log('last words');",
          "process.exitCode = 3;",
        ].join("\n"),
      );

      const result = yield* runner.run({
        commands: [node(failing), node(failing)],
        cwd: dir,
      });

      expect(result.ok).toBe(false);
      const [first, second] = result.commands;
      expect(second).toEqual({ command: node(failing), status: "skipped" });
      expect(first).toMatchObject({
        status: "failed",
        exitCode: 3,
        lineCount: 203,
        matchedLineCount: 2,
        matchedLinesInLogOnly: 0,
      });
      if (first?.status !== "failed") return;
      expect(first.matchedLines.map((match) => match.text)).toEqual([
        "Warning: disk almost full",
        "Error: boom",
      ]);
      // stdout and stderr are separate pipes, so only their own order is fixed.
      expect(first.tail).toHaveLength(30);
      expect(first.tail).toContain("last words");

      const log = yield* Effect.promise(() => readFile(result.logPath, "utf8"));
      expect(log).toContain("line 1\n");
      expect(log).toContain("line 200\n");
      expect(log).toContain("Error: boom");
      expect(log).toContain("[failed exit=3");
    }),
  ),
);

it.live("kills the whole process tree when a command times out", () =>
  withFixture(({ dir, runner, script }) =>
    Effect.gen(function* () {
      const grandchild = yield* script("hang.cjs", "setInterval(() => {}, 1000);");
      const parent = yield* script(
        "spawn-hang.cjs",
        [
          "const { spawn } = require('node:child_process');",
          `const child = spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'inherit', windowsHide: true });`,
          "console.log('grandchild ' + child.pid);",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );

      const result = yield* runner.run({ commands: [node(parent)], cwd: dir, timeoutMs: 1_500 });

      const [only] = result.commands;
      expect(only?.status).toBe("timed_out");
      if (only?.status !== "timed_out") return;
      const pid = Number(only.tail?.find((line) => line.startsWith("grandchild "))?.split(" ")[1]);
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).toThrow();
    }),
  ),
);

it.live("refuses a cwd that is not a directory", () =>
  withFixture(({ dir, runner }) =>
    Effect.gen(function* () {
      const error = yield* runner
        .run({ commands: ["echo hi"], cwd: join(dir, "missing") })
        .pipe(Effect.flip);
      expect(error._tag).toBe("BatchCommandInputError");
      const relative = yield* runner.run({ commands: ["echo hi"], cwd: "." }).pipe(Effect.flip);
      expect(relative.message).toContain("absolute");
    }),
  ),
);

it.live("hides T3 server variables from commands", () =>
  withFixture(({ dir, runner, script }) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        process.env.T3CODE_BATCH_PROBE = "leaked";
      }),
      () =>
        Effect.gen(function* () {
          const probe = yield* script(
            "env.cjs",
            "console.log('probe=' + (process.env.T3CODE_BATCH_PROBE ?? 'none')); process.exit(1);",
          );
          const result = yield* runner.run({ commands: [node(probe)], cwd: dir });
          const [only] = result.commands;
          expect(only?.status === "failed" ? only.tail : undefined).toEqual(["probe=none"]);
        }),
      () =>
        Effect.sync(() => {
          delete process.env.T3CODE_BATCH_PROBE;
        }),
    ),
  ),
);

it.live("stops at the batch limit, kills the running command and skips the rest", () =>
  withFixture(
    ({ dir, runner, script }) =>
      Effect.gen(function* () {
        const hang = yield* script("hang.cjs", "setInterval(() => {}, 1000);");
        const result = yield* runner.run({ commands: [node(hang), "echo never"], cwd: dir });
        expect(result.batchTimedOut).toBe(true);
        expect(result.commands.map((command) => command.status)).toEqual(["timed_out", "skipped"]);
      }),
    { maxBatchMs: 1_000 },
  ),
);

it.live("deletes logs past the retention age and count when a batch starts", () =>
  withFixture(
    ({ dir, runner }) =>
      Effect.gen(function* () {
        const logsDir = join(dir, "logs");
        const day = Math.floor(Date.UTC(2026, 10, 27) / 1000);
        yield* Effect.promise(async () => {
          await mkdir(logsDir, { recursive: true });
          const mtimes = {
            "ancient.log": 946_684_800,
            "older.log": day - 20,
            "old.log": day - 10,
            "keep.txt": 0,
          };
          for (const [name, seconds] of Object.entries(mtimes)) {
            await writeFile(join(logsDir, name), name);
            await utimes(join(logsDir, name), seconds, seconds);
          }
        });
        const logNames = () =>
          Effect.promise(() => readdir(logsDir)).pipe(Effect.map((names) => names.toSorted()));

        const first = yield* runner.run({ commands: ["echo hi"], cwd: dir });
        const firstName = first.logPath.slice(logsDir.length + 1);
        expect(yield* logNames()).toEqual(
          [firstName, "keep.txt", "old.log", "older.log"].toSorted(),
        );

        const byCount = BatchCommandRunner.make({
          ...BatchCommandRunner.DEFAULT_BATCH_COMMAND_RUNNER_CONFIG,
          logsDir,
          maxLogAgeMs: Number.MAX_SAFE_INTEGER,
          maxLogCount: 2,
        });
        const second = yield* byCount.run({ commands: ["echo hi"], cwd: dir });
        expect(yield* logNames()).toEqual(
          [firstName, second.logPath.slice(logsDir.length + 1), "keep.txt"].toSorted(),
        );
      }),
    // Ten years: old enough to drop the 2000 log, young enough to keep the 2026 ones.
    { maxLogAgeMs: 10 * 365 * 24 * 60 * 60_000 },
  ),
);
