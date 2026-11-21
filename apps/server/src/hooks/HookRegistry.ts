// @effect-diagnostics nodeBuiltinImport:off
import { createHash, randomUUID } from "node:crypto";

import {
  HookDecision,
  HookDefinition,
  HookEvent,
  HookScope,
  HookRegistryError,
  HookUpdateDraftInput,
  ProjectId,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as HookScriptRunner from "./HookScriptRunner.ts";

/** Older mobile clients use a closed event enum; do not send events they cannot decode. */
export function hooksVisibleToClient(
  hooks: readonly HookDefinition[],
  supportedEvents?: readonly HookEvent[],
) {
  const supported = new Set<HookEvent>(
    supportedEvents ?? [
      "before_file_write",
      "before_provider_turn_start",
      "turn_end",
      "before_github_push",
    ],
  );
  return hooks.filter((hook) => supported.has(hook.event));
}

export function blockedHookGuidance(messages: readonly string[], fallback: string): string {
  const reason = messages.filter((message) => message.trim().length > 0).join("\n") || fallback;
  return `${reason}\n\nThe action was blocked. Follow the hook rule and relevant AGENTS.md instructions; change your approach before retrying. If compliant progress requires user approval, ask rather than bypassing the hook.`;
}

type HookRegistryServices = FileSystem.FileSystem | Path.Path | HookScriptRunner.HookScriptRunner;
const RegistryState = Schema.Struct({ hooks: Schema.Array(HookDefinition) });
const encodeState = Schema.encodeEffect(Schema.fromJsonString(RegistryState));
const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(RegistryState));
export class HookRegistry extends Context.Service<
  HookRegistry,
  {
    readonly list: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<HookDefinition>, HookRegistryError>;
    readonly createDraft: (input: {
      readonly projectId: ProjectId;
      readonly scope?: HookScope | undefined;
      readonly name: string;
      readonly event: HookEvent;
      readonly script: string;
    }) => Effect.Effect<HookDefinition, HookRegistryError>;
    readonly approve: (input: {
      readonly projectId: ProjectId;
      readonly hookId: string;
      readonly reviewedSha256: string;
      readonly reviewedEvent?: HookEvent | undefined;
      readonly reviewedScope?: HookScope | undefined;
    }) => Effect.Effect<HookDefinition, HookRegistryError>;
    readonly updateDraft: (
      input: HookUpdateDraftInput,
    ) => Effect.Effect<HookDefinition, HookRegistryError>;
    readonly setEnabled: (input: {
      readonly projectId: ProjectId;
      readonly hookId: string;
      readonly enabled: boolean;
    }) => Effect.Effect<HookDefinition, HookRegistryError>;
    readonly runEvent: (input: {
      readonly projectId: ProjectId;
      readonly event: HookEvent;
      readonly payload: unknown;
    }) => Effect.Effect<
      {
        readonly allowed: boolean;
        readonly messages: ReadonlyArray<string>;
        readonly enforcement?: "managed-worktree";
        readonly action?: "install-staged-files";
        readonly continueWork?: boolean;
      },
      HookRegistryError,
      never
    >;
  }
>()("t3/hooks/HookRegistry") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const scriptRunner = yield* HookScriptRunner.HookScriptRunner;
  const lock = yield* Semaphore.make(1);
  const directory = path.join(config.stateDir, "hooks", "projects");

  const registryPath = (projectId: ProjectId, scope: HookScope = "project") =>
    scope === "all-projects"
      ? path.join(config.stateDir, "hooks", "all-projects.json")
      : path.join(directory, createHash("sha256").update(projectId).digest("hex") + ".json");

  const readHooks = Effect.fn("HookRegistry.read")(
    function* (projectId: ProjectId, scope: HookScope = "project") {
      const filePath = registryPath(projectId, scope);
      const exists = yield* fileSystem.exists(filePath);
      if (!exists) return [] as ReadonlyArray<HookDefinition>;
      const contents = yield* fileSystem.readFileString(filePath);
      const state = yield* decodeState(contents);
      if (state.hooks.some((hook) => (hook.scope ?? "project") !== scope)) {
        return yield* new HookRegistryError({ reason: "storage" });
      }
      return state.hooks;
    },
    Effect.mapError((cause) => new HookRegistryError({ reason: "storage", cause })),
  );
  const saveHooks = Effect.fn("HookRegistry.save")(
    function* (
      projectId: ProjectId,
      hooks: ReadonlyArray<HookDefinition>,
      scope: HookScope = "project",
    ) {
      const contents = yield* encodeState({ hooks });
      yield* writeFileStringAtomically({ filePath: registryPath(projectId, scope), contents }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(HostProcess.Platform, platform),
      );
    },
    Effect.mapError((cause) => new HookRegistryError({ reason: "storage", cause })),
  );
  const list: HookRegistry["Service"]["list"] = Effect.fn("HookRegistry.list")(
    function* (projectId) {
      const global = yield* readHooks(projectId, "all-projects");
      const project = yield* readHooks(projectId);
      return [...global, ...project];
    },
  );

  const findHooks = Effect.fn("HookRegistry.find")(function* (
    projectId: ProjectId,
    hookId: string,
  ) {
    const project = yield* readHooks(projectId);
    if (project.some((hook) => hook.id === hookId))
      return { hooks: project, scope: "project" as const };
    const global = yield* readHooks(projectId, "all-projects");
    return { hooks: global, scope: "all-projects" as const };
  });

  const createDraft: HookRegistry["Service"]["createDraft"] = Effect.fn("HookRegistry.createDraft")(
    function* (input) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const scope = input.scope ?? "project";
          const hooks = yield* readHooks(input.projectId, scope);
          if (hooks.length >= 200) return yield* new HookRegistryError({ reason: "too-many" });
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          const hook: HookDefinition = {
            id: randomUUID(),
            projectId: input.projectId,
            scope,
            name: input.name.trim(),
            event: input.event,
            script: input.script,
            scriptSha256: createHash("sha256").update(input.script, "utf8").digest("hex"),
            status: "draft",
            enabled: false,
            createdAt: now,
          };
          yield* saveHooks(input.projectId, [...hooks, hook], scope);
          return hook;
        }),
      );
    },
  );

  const approve: HookRegistry["Service"]["approve"] = Effect.fn("HookRegistry.approve")(
    function* (input) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const { hooks, scope } = yield* findHooks(input.projectId, input.hookId);
          const index = hooks.findIndex((hook) => hook.id === input.hookId);
          if (index < 0) return yield* new HookRegistryError({ reason: "not-found" });
          const hook = hooks[index]!;
          if (hook.status !== "draft") return yield* new HookRegistryError({ reason: "not-draft" });
          const currentHash = createHash("sha256").update(hook.script, "utf8").digest("hex");
          const hookScope = hook.scope ?? "project";
          if (
            currentHash !== input.reviewedSha256 ||
            hook.scriptSha256 !== currentHash ||
            (hookScope === "all-projects" &&
              (input.reviewedEvent === undefined || input.reviewedScope === undefined)) ||
            (input.reviewedEvent !== undefined && input.reviewedEvent !== hook.event) ||
            (input.reviewedScope !== undefined && input.reviewedScope !== hookScope)
          ) {
            return yield* new HookRegistryError({ reason: "approval-mismatch" });
          }
          const approved: HookDefinition = {
            ...hook,
            status: "active",
            enabled: true,
            approvedAt: DateTime.toEpochMillis(yield* DateTime.now),
            approvedEvent: hook.event,
            approvedScope: hookScope,
          };
          const next = [...hooks];
          next[index] = approved;
          yield* saveHooks(input.projectId, next, scope);
          return approved;
        }),
      );
    },
  );

  const updateDraft: HookRegistry["Service"]["updateDraft"] = Effect.fn("HookRegistry.updateDraft")(
    function* (input) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const { hooks, scope } = yield* findHooks(input.projectId, input.hookId);
          const index = hooks.findIndex((hook) => hook.id === input.hookId);
          if (index < 0) return yield* new HookRegistryError({ reason: "not-found" });
          const hook = hooks[index]!;
          if (hook.status !== "draft") return yield* new HookRegistryError({ reason: "not-draft" });
          const updated: HookDefinition = {
            ...hook,
            script: input.script,
            scriptSha256: createHash("sha256").update(input.script, "utf8").digest("hex"),
          };
          const next = [...hooks];
          next[index] = updated;
          yield* saveHooks(input.projectId, next, scope);
          return updated;
        }),
      );
    },
  );

  const setEnabled: HookRegistry["Service"]["setEnabled"] = Effect.fn("HookRegistry.setEnabled")(
    function* (input) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const { hooks, scope } = yield* findHooks(input.projectId, input.hookId);
          const index = hooks.findIndex((hook) => hook.id === input.hookId);
          if (index < 0) return yield* new HookRegistryError({ reason: "not-found" });
          const hook = hooks[index]!;
          if (hook.status !== "active")
            return yield* new HookRegistryError({ reason: "not-active" });
          const updated = { ...hook, enabled: input.enabled };
          const next = [...hooks];
          next[index] = updated;
          yield* saveHooks(input.projectId, next, scope);
          return updated;
        }),
      );
    },
  );

  const runEvent: HookRegistry["Service"]["runEvent"] = Effect.fn("HookRegistry.runEvent")(
    function* (input) {
      const hooks = yield* list(input.projectId);
      const messages: Array<string> = [];
      let enforcement: "managed-worktree" | undefined;
      let action: "install-staged-files" | undefined;
      let continueWork = false;
      for (const hook of hooks) {
        if (hook.status !== "active" || !hook.enabled || hook.event !== input.event) continue;
        if (
          createHash("sha256").update(hook.script, "utf8").digest("hex") !== hook.scriptSha256 ||
          (hook.approvedEvent !== undefined && hook.approvedEvent !== hook.event) ||
          (hook.approvedScope !== undefined && hook.approvedScope !== (hook.scope ?? "project"))
        ) {
          return {
            allowed: false,
            messages: [
              ...messages,
              "An active hook no longer matches its approved script, event, or scope.",
            ],
          };
        }
        const output = yield* scriptRunner
          .run({ script: hook.script, input: { event: input.event, payload: input.payload } })
          .pipe(Effect.orElseSucceed(() => null));
        if (output === null) {
          return {
            allowed: false,
            messages: [...messages, "An active hook failed; the operation was blocked."],
          };
        }
        const decoded = yield* Schema.decodeUnknownEffect(HookDecision)(output).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        if (decoded === undefined) {
          return {
            allowed: false,
            messages: [
              ...messages,
              "An active hook returned an invalid decision; the operation was blocked.",
            ],
          };
        }
        if (
          (decoded.action !== undefined || decoded.continueWork === true) &&
          input.event !== "turn_end"
        ) {
          return {
            allowed: false,
            messages: [...messages, "This hook action is not supported for its event."],
          };
        }
        if (decoded.decision === "block") {
          messages.push(decoded.message ?? "Blocked by an active hook.");
          return {
            allowed: false,
            messages,
            ...(enforcement === undefined ? {} : { enforcement }),
            ...(action === undefined ? {} : { action }),
          };
        }
        if (decoded.message !== undefined) messages.push(decoded.message);
        if (input.event === "before_provider_turn_start" && decoded.enforcement !== undefined) {
          enforcement = decoded.enforcement;
        }
        if (decoded.action !== undefined) action = decoded.action;
        if (decoded.continueWork === true) continueWork = true;
      }
      return {
        allowed: true,
        messages,
        ...(enforcement === undefined ? {} : { enforcement }),
        ...(action === undefined ? {} : { action }),
        ...(continueWork ? { continueWork: true } : {}),
      };
    },
  );

  return HookRegistry.of({ list, createDraft, approve, updateDraft, setEnabled, runEvent });
});

export const layer = Layer.effect(HookRegistry, make);
