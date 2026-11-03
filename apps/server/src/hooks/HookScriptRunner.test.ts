import { it, expect, describe } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HookScriptRunner from "./HookScriptRunner.ts";

describe("HookScriptRunner", () => {
  it.layer(HookScriptRunner.layer, { excludeTestServices: true })(
    "restricted script execution",
    (it) => {
      it.effect("returns a JSON decision from approved script source", () =>
        Effect.gen(function* () {
          const runner = yield* HookScriptRunner.HookScriptRunner;
          const result = yield* runner.run({
            script: "return { action: input.action, paths: input.paths };",
            input: { action: "stage", paths: ["src/main.ts"] },
          });
          expect(result).toEqual({ action: "stage", paths: ["src/main.ts"] });
        }),
      );

      it.effect("preserves Electron Node mode for the restricted hook child", () =>
        Effect.gen(function* () {
          const original = Object.getOwnPropertyDescriptor(process.versions, "electron");
          Object.defineProperty(process.versions, "electron", {
            value: "test",
            configurable: true,
          });
          try {
            const runner = yield* HookScriptRunner.HookScriptRunner;
            const result = yield* runner.run({
              script: "return { mode: process.env.ELECTRON_RUN_AS_NODE };",
              input: {},
            });
            expect(result).toEqual({ mode: "1" });
          } finally {
            if (original) Object.defineProperty(process.versions, "electron", original);
            else Reflect.deleteProperty(process.versions, "electron");
          }
        }),
      );
      it.effect("blocks direct filesystem reads and child processes", () =>
        Effect.gen(function* () {
          const runner = yield* HookScriptRunner.HookScriptRunner;
          const filesystem = yield* runner
            .run({
              script:
                'return process.getBuiltinModule("node:fs").readFileSync(input.path, "utf8");',
              input: { path: process.cwd() + "/AGENTS.md" },
            })
            .pipe(Effect.flip);
          const childProcess = yield* runner
            .run({
              script:
                'return process.getBuiltinModule("node:child_process").spawnSync("cmd.exe", ["/c", "ver"]).status;',
              input: {},
            })
            .pipe(Effect.flip);
          expect(filesystem._tag).toBe("HookScriptRunnerError");
          expect(childProcess._tag).toBe("HookScriptRunnerError");
        }),
      );

      it.effect("stops an infinite script at the execution deadline", () =>
        Effect.gen(function* () {
          const runner = yield* HookScriptRunner.HookScriptRunner;
          const error = yield* runner
            .run({ script: "while (true) {}", input: {} })
            .pipe(Effect.flip);
          expect(error.reason).toBe("timed-out");
        }),
      );

      it.effect("rejects oversized scripts before spawning", () =>
        Effect.gen(function* () {
          const runner = yield* HookScriptRunner.HookScriptRunner;
          const error = yield* runner
            .run({ script: " ".repeat(16 * 1024 + 1), input: {} })
            .pipe(Effect.flip);
          expect(error.reason).toBe("invalid-input");
        }),
      );
    },
  );
});
