// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const MAX_HOOK_SCRIPT_BYTES = 16 * 1024;
const MAX_HOOK_INPUT_BYTES = 256 * 1024;
const MAX_HOOK_OUTPUT_BYTES = 64 * 1024;
const HOOK_TIMEOUT_MS = 5_000;
const RESULT_MARKER = "__T3_HOOK_RESULT__";
const JsonString = Schema.fromJsonString(Schema.Json);
const encodeJson = Schema.encodeUnknownEffect(JsonString);
const decodeJson = Schema.decodeUnknownEffect(JsonString);

const BOOTSTRAP = [
  'process.stdin.setEncoding("utf8");',
  'let raw = "";',
  'process.stdin.on("data", (chunk) => raw += chunk);',
  'process.stdin.on("end", () => {',
  "  void (async () => {",
  "    const request = JSON.parse(raw);",
  "    const freeze = (value) => {",
  '      if (value && typeof value === "object" && !Object.isFrozen(value)) {',
  "        for (const child of Object.values(value)) freeze(child);",
  "        Object.freeze(value);",
  "      }",
  "      return value;",
  "    };",
  "    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;",
  '    const run = new AsyncFunction("input", "\'use strict;\'" + String.fromCharCode(10) + request.script);',
  "    const result = await run(freeze(request.input));",
  "    const encoded = JSON.stringify(result);",
  '    if (encoded === undefined) throw new TypeError("Hook script must return a JSON value");',
  '    process.stdout.write(String.fromCharCode(10) + "__T3_HOOK_RESULT__" + Buffer.from(encoded).toString("base64url") + String.fromCharCode(10));',
  "  })().catch(() => { process.exitCode = 1; });",
  "});",
].join(String.fromCharCode(10));

export class HookScriptRunnerError extends Schema.TaggedError<HookScriptRunnerError>()(
  "HookScriptRunnerError",
  {
    reason: Schema.Literals(["invalid-input", "timed-out", "failed", "output-limit"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "invalid-input":
        return "Hook script input or output was invalid.";
      case "timed-out":
        return "Hook script exceeded its execution time limit.";
      case "failed":
        return "Hook script failed in its restricted runtime.";
      case "output-limit":
        return "Hook script exceeded its output limit.";
    }
  }
}

export class HookScriptRunner extends Context.Service<
  HookScriptRunner,
  {
    readonly run: (input: {
      readonly script: string;
      readonly input: unknown;
    }) => Effect.Effect<Schema.Json, HookScriptRunnerError>;
  }
>()("t3/hooks/HookScriptRunner") {}

const make = Effect.sync(() => {
  const run: HookScriptRunner["Service"]["run"] = Effect.fn("HookScriptRunner.run")(function* ({
    script,
    input,
  }) {
    if (Buffer.byteLength(script, "utf8") > MAX_HOOK_SCRIPT_BYTES) {
      return yield* new HookScriptRunnerError({ reason: "invalid-input" });
    }
    const request = yield* encodeJson({ script, input }).pipe(
      Effect.mapError((cause) => new HookScriptRunnerError({ reason: "invalid-input", cause })),
    );
    if (Buffer.byteLength(request, "utf8") > MAX_HOOK_INPUT_BYTES) {
      return yield* new HookScriptRunnerError({ reason: "invalid-input" });
    }

    const encoded = yield* Effect.tryPromise({
      try: (signal) =>
        new Promise<string>((resolve, reject) => {
          const child = NodeChildProcess.spawn(
            process.execPath,
            ["--permission", "--max-old-space-size=64", "--eval", BOOTSTRAP],
            {
              cwd: process.cwd(),
              env: {
                ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
                ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
                // The desktop server itself runs Electron as Node; retain that mode for hooks.
                ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
              },
              stdio: ["pipe", "pipe", "ignore"],
              windowsHide: true,
            },
          );
          let stdout = "";
          let outputLimitHit = false;
          const stop = () => child.kill();
          if (signal.aborted) stop();
          else signal.addEventListener("abort", stop, { once: true });

          child.stdout.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => {
            stdout += chunk;
            if (Buffer.byteLength(stdout, "utf8") > MAX_HOOK_OUTPUT_BYTES) {
              outputLimitHit = true;
              child.kill();
            }
          });
          child.once("error", reject);
          child.once("close", (code) => {
            signal.removeEventListener("abort", stop);
            if (outputLimitHit) {
              reject(new HookScriptRunnerError({ reason: "output-limit" }));
              return;
            }
            if (code !== 0) {
              reject(new HookScriptRunnerError({ reason: "failed" }));
              return;
            }
            const marker = String.fromCharCode(10) + RESULT_MARKER;
            const markerIndex = stdout.lastIndexOf(marker);
            if (markerIndex < 0) {
              reject(new HookScriptRunnerError({ reason: "invalid-input" }));
              return;
            }
            resolve(stdout.slice(markerIndex + marker.length).trim());
          });
          child.stdin.once("error", () => undefined);
          child.stdin.end(request);
        }),
      catch: (cause) =>
        isHookScriptRunnerError(cause)
          ? cause
          : new HookScriptRunnerError({ reason: "failed", cause }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: HOOK_TIMEOUT_MS,
        orElse: () => Effect.fail(new HookScriptRunnerError({ reason: "timed-out" })),
      }),
    );

    return yield* decodeJson(Buffer.from(encoded, "base64url").toString("utf8")).pipe(
      Effect.mapError((cause) => new HookScriptRunnerError({ reason: "invalid-input", cause })),
    );
  });
  return HookScriptRunner.of({ run });
});

export const layer = Layer.effect(HookScriptRunner, make);

const isHookScriptRunnerError = Schema.is(HookScriptRunnerError);
