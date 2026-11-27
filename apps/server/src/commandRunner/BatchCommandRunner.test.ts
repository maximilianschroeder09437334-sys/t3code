import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    }),
  ),
);
