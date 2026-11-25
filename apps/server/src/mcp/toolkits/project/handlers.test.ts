import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  GitCommandError,
  ProjectId,
  NodeId,
  ProviderInstanceId,
  ProviderDriverKind,
  RunId,
  ThreadId,
  type ServerProvider,
  type Project as ProjectRecord,
  type ModelSelection,
  type RuntimeMode,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import * as DocumentText from "../../../provider/DocumentText.ts";
import { OrchestratorRuntimeModeAboveCeilingError } from "../../../orchestration-v2/Orchestrator.ts";
import * as HookRegistry from "../../../hooks/HookRegistry.ts";
import * as HookStagingManager from "../../../hooks/HookStagingManager.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerConfig from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ProjectCloneTracker from "../../../project/ProjectCloneTracker.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as SourceControlProviderRegistry from "../../../sourceControl/SourceControlProviderRegistry.ts";
import * as Repositories from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectHandlers from "./handlers.ts";
import { ProjectToolkit } from "./tools.ts";

const fixtureSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6.1-terra",
  options: [{ id: "reasoningEffort", value: "medium" }],
};
const fixtureProvider = {
  instanceId: fixtureSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  status: "ready",
  version: null,
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00Z",
  models: ["gpt-6.1-terra", "gpt-settings"].map((slug) => ({
    slug,
    name: slug,
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Effort",
          type: "select",
          options: [{ id: "medium", label: "Medium" }],
        },
      ],
    },
  })),
  slashCommands: [],
  skills: [],
} as unknown as ServerProvider;

/** The task row fields a delegated child's launch reads. */
interface HandoffTask {
  readonly id: NodeId;
  readonly origin: "app_owned";
  childThreadId: ThreadId | null;
  readonly result: string | null;
  readonly completedAt: null;
  readonly startedAt: null;
  readonly cancelledRunId?: RunId;
}

const clientLaunchHarness = (input: {
  readonly runtimeModeCeiling: RuntimeMode;
  readonly defaultRuntimeMode?: RuntimeMode;
  readonly newWorktreesStartFromOrigin?: boolean;
  readonly fallbackModel?: ModelSelection;
  readonly providers?: readonly ServerProvider[];
  /** Where Settings saves a project's model; the legacy project field stays null. */
  readonly overrideModel?: ModelSelection;
  readonly launched: Array<ThreadLaunch.ThreadLaunchInput>;
  readonly workspaceRoot?: string;
  readonly checkWorktreeBase?: ThreadLaunch.ThreadLaunchService["Service"]["checkWorktreeBase"];
  readonly hostedAppUrl?: string;
  /** The orchestrator refuses the new thread's mode, as under a managed ceiling. */
  readonly refusedByCeiling?: true;
  /** An agent thread bound to the MCP session makes the call instead of the client. */
  readonly callerThreadId?: ThreadId;
  /** The calling thread's own fields, e.g. a delegated child's lineage. */
  readonly callerShell?: Partial<OrchestrationV2ThreadShell>;
  /** The owner's task rows a delegated caller's launch reads; its handoff rebinds them. */
  readonly tasks?: Array<HandoffTask>;
  readonly dispatched?: Array<{ readonly type: string }>;
  /** The runs the launch asked ThreadLaunchService to prepare. */
  readonly prepared?: Array<ThreadLaunch.ThreadLaunchPreparationInput>;
}) => {
  const successors = new Map<ThreadId, OrchestrationV2ThreadShell>();
  /** A successor started with a workspace strategy waits in "preparing", as the orchestrator's does. */
  const projectId = ProjectId.make("project:client-target");
  const modelSelection = fixtureSelection;
  // The project's own default model, which a test can clear between launches.
  const projectDefaults: { model: ModelSelection | null } = {
    model: input.overrideModel === undefined ? modelSelection : null,
  };
  const layerDependencies = Layer.mergeAll(
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed(input.providers ?? [fixtureProvider]),
    }),
    ServerSettings.layerTest({
      fallbackModelSelection: input.fallbackModel ?? null,
      ...(input.defaultRuntimeMode === undefined
        ? {}
        : { defaultRuntimeMode: input.defaultRuntimeMode }),
      ...(input.newWorktreesStartFromOrigin === undefined
        ? {}
        : { newWorktreesStartFromOrigin: input.newWorktreesStartFromOrigin }),
      ...(input.overrideModel === undefined
        ? {}
        : {
            projectSettingsFolded: true,
            projectSettingsOverrides: {
              [projectId]: { defaultModelSelection: input.overrideModel },
            },
          }),
    }),
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "client:session-1",
      thread:
        input.callerThreadId === undefined
          ? undefined
          : {
              threadId: input.callerThreadId,
              providerSessionId: "provider-session:caller",
              providerInstanceId: fixtureSelection.instanceId,
            },
      client: {
        sessionId: "session-1",
        label: "Claude Code",
        access: input.runtimeModeCeiling,
        hostedAppUrl: input.hostedAppUrl,
      },
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      // A thread exists once a launch or handoff started it; read when the effect runs.
      getThreadShell: (threadId) =>
        Effect.suspend(() => {
          if (threadId === input.callerThreadId)
            return Effect.succeed({
              ...McpToolAccessTestkit.liveThreadShell(threadId, {
                runtimeMode: input.runtimeModeCeiling,
              }),
              projectId,
              modelSelection,
              ...input.callerShell,
            } as OrchestrationV2ThreadShell);
          const successor = successors.get(threadId);
          if (successor !== undefined) return Effect.succeed(successor);
          const launch = input.launched.find((candidate) => candidate.threadId === threadId);
          return Effect.succeed(
            launch === undefined
              ? null
              : ({
                  id: launch.threadId,
                  projectId: launch.projectId,
                  modelSelection: launch.modelSelection,
                  deletedAt: null,
                } as unknown as OrchestrationV2ThreadShell),
          );
        }),
      getThreadRecords: () =>
        Effect.succeed({
          subagents: input.tasks ?? [],
        } as never),
      // The orchestrator's handoff, reduced: an open task bound to the caller moves to the successor.
      dispatch: (command) => {
        input.dispatched?.push(command);
        if (command.type === "delegated_task.handoff") {
          const task = input.tasks?.find(
            (row) =>
              row.id === command.taskId &&
              row.childThreadId === command.fromChildThreadId &&
              row.result === null &&
              row.cancelledRunId === undefined,
          );
          if (task !== undefined) {
            const id = IdAllocator.derive.delegatedTaskThread({ commandId: command.commandId });
            task.childThreadId = id;
            successors.set(id, {
              id,
              projectId,
              title: "Successor",
              modelSelection,
              deletedAt: null,
            } as unknown as OrchestrationV2ThreadShell);
          }
        }
        return Effect.succeed({ sequence: 1 } as never);
      },
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      checkWorktreeBase: input.checkWorktreeBase ?? (() => Effect.void),
      prepareRun: (prepared) => Effect.sync(() => input.prepared?.push(prepared)),
      launch: (launch) => {
        input.launched.push(launch);
        if (input.refusedByCeiling) {
          return Effect.fail(
            new ThreadLaunch.ThreadLaunchError({
              operation: "create-thread",
              commandId: launch.commandId,
              projectId: launch.projectId,
              cause: new OrchestratorRuntimeModeAboveCeilingError({
                commandId: launch.commandId,
                threadId: launch.threadId ?? ThreadId.make("thread:refused"),
                refused: "mode",
                runtimeMode: launch.runtimeMode,
                maxRuntimeMode: "approval-required",
                organization: "Example Corp",
              }),
            }),
          );
        }
        return Effect.succeed({
          threadId: launch.threadId,
          projection: {
            thread: {
              id: launch.threadId,
              projectId: launch.projectId,
              title: launch.title,
              modelSelection: launch.modelSelection,
            },
            runs: [],
          },
          resumed: false,
        } as unknown as ThreadLaunch.ThreadLaunchResult);
      },
    }),
    Layer.mock(Project.ProjectService)({
      getById: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some({
                id,
                workspaceRoot: input.workspaceRoot ?? "/projects/client-target",
                defaultModelSelection: projectDefaults.model,
              } as unknown as ProjectRecord)
            : Option.none(),
        ),
    }),
    Layer.mock(PeerForwarding.PeerForwarding)({}),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      isScratchProject: () => Effect.succeed(false),
    }),
    DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer)),
  ).pipe(
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-client-launch-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  return { projectId, modelSelection, projectDefaults, dependencies: layerDependencies };
};

it.effect(
  "a client launches with the project's default model and mode, capped at its ceiling",
  () =>
    Effect.gen(function* () {
      const launchWith = Effect.fn("test.launchWith")(function* (
        runtimeModeCeiling: RuntimeMode,
        defaultRuntimeMode: RuntimeMode,
        params: {
          readonly title: string;
          readonly message?: string;
          readonly runtimeMode?: RuntimeMode;
          readonly targeted?: false;
          readonly overrideModel?: ModelSelection;
          readonly hostedAppUrl?: string;
          readonly refusedByCeiling?: true;
        },
      ) {
        const { targeted, overrideModel, hostedAppUrl, refusedByCeiling, ...input } = params;
        const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
        const { projectId, modelSelection, dependencies } = clientLaunchHarness({
          runtimeModeCeiling,
          defaultRuntimeMode,
          launched,
          ...(overrideModel === undefined ? {} : { overrideModel }),
          ...(hostedAppUrl === undefined ? {} : { hostedAppUrl }),
          ...(refusedByCeiling === undefined ? {} : { refusedByCeiling }),
        });
        const toolkit = yield* ProjectToolkit.pipe(
          Effect.provide(
            McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
              Layer.provide(dependencies),
            ),
          ),
        );
        const result = yield* toolkit
          .handle(
            "t3_thread_launch",
            targeted === false
              ? { modelSelection: overrideModel ?? modelSelection, ...input }
              : { modelSelection: overrideModel ?? modelSelection, ...input, projectId },
          )
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
        return { result: result.at(-1)?.result, launched, projectId, modelSelection };
      });

      const belowCeiling = yield* launchWith("full-access", "approval-required", {
        title: "Fix",
        message: "Fix the bug",
      });
      expect(belowCeiling.result).toMatchObject({
        projectId: belowCeiling.projectId,
        modelSelection: belowCeiling.modelSelection,
        link: `[Fix](https://app.t3.codes/threads/environment/${encodeURIComponent(belowCeiling.launched[0]!.threadId!)})`,
      });
      expect(belowCeiling.launched[0]?.runtimeMode).toBe("approval-required");
      expect(belowCeiling.launched[0]?.initialMessage?.senderThreadId).toBeUndefined();
      // A client has no thread to prove a later takeover with.
      expect(belowCeiling.launched[0]).not.toHaveProperty("launchedBy");

      const aboveCeiling = yield* launchWith("auto-accept-edits", "full-access", {
        title: "Fix",
        hostedAppUrl: "https://t3.example.com",
      });
      expect(aboveCeiling.launched[0]?.runtimeMode).toBe("auto-accept-edits");
      expect(aboveCeiling.result).toMatchObject({
        link: `https://t3.example.com/threads/environment/${encodeURIComponent(aboveCeiling.launched[0]?.threadId ?? "")}`,
      });

      const requested = yield* launchWith("full-access", "approval-required", {
        title: "Fix",
        runtimeMode: "full-access",
      });
      expect(requested.launched[0]?.runtimeMode).toBe("full-access");

      const escalated = yield* launchWith("auto-accept-edits", "auto-accept-edits", {
        title: "Fix",
        runtimeMode: "full-access",
      });
      expect(escalated.result).toMatchObject({ code: "runtime_mode_escalation_denied" });
      expect(escalated.launched).toHaveLength(0);

      const untargeted = yield* launchWith("full-access", "full-access", {
        title: "Fix",
        targeted: false,
      });
      expect(untargeted.result).toMatchObject({ code: "target_required" });

      const overrideModel = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-settings",
        options: [{ id: "reasoningEffort", value: "medium" }],
      };
      const fromSettings = yield* launchWith("full-access", "full-access", {
        title: "Fix",
        overrideModel,
      });
      expect(fromSettings.launched[0]?.modelSelection).toEqual(overrideModel);

      // An administrator's ceiling the orchestrator enforces is named, not reported as unavailable.
      const managed = yield* launchWith("full-access", "full-access", {
        title: "Fix",
        refusedByCeiling: true,
      });
      expect(managed.result).toMatchObject({
        code: "invalid_request",
        message: "Example Corp limits threads to Supervised.",
      });
    }),
);

it.effect("an agent's launch records the bound calling thread as the launcher", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const callerThreadId = ThreadId.make("thread:predecessor");
    const { projectId, modelSelection, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "full-access",
      launched,
      callerThreadId,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    yield* toolkit
      .handle("t3_thread_launch", { projectId, title: "Successor", modelSelection })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(launched).toHaveLength(1);
    expect(launched[0]?.launchedBy).toMatchObject({
      threadId: callerThreadId,
      commandId: launched[0]?.commandId,
    });
  }),
);

it.effect("a launch steps an inherited mode down to the provider's, and refuses one it lacks", () =>
  Effect.gen(function* () {
    // Pi offers no Auto; a mode a provider lacks would run as Supervised.
    const pi = ProviderInstanceId.make("pi");
    const launchPi = Effect.fn("test.launchPi")(function* (runtimeMode?: RuntimeMode) {
      const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
      const { projectId, dependencies } = clientLaunchHarness({
        runtimeModeCeiling: "auto",
        launched,
        providers: [
          {
            instanceId: pi,
            driver: ProviderDriverKind.make("pi"),
            enabled: true,
            installed: true,
            status: "ready",
            version: null,
            auth: { status: "authenticated" },
            checkedAt: "2026-01-01T00:00:00Z",
            models: [
              {
                slug: "pi-model",
                name: "Pi",
                isCustom: false,
                capabilities: {
                  optionDescriptors: [
                    {
                      id: "effort",
                      label: "Effort",
                      type: "select",
                      options: [{ id: "medium", label: "Medium" }],
                    },
                  ],
                },
              },
            ],
            slashCommands: [],
            skills: [],
            supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
          },
        ],
      });
      const toolkit = yield* ProjectToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
            Layer.provide(dependencies),
          ),
        ),
      );
      const result = yield* toolkit
        .handle("t3_thread_launch", {
          projectId,
          title: "Fix",
          modelSelection: {
            instanceId: pi,
            model: "pi-model",
            options: [{ id: "effort", value: "medium" }],
          },
          ...(runtimeMode === undefined ? {} : { runtimeMode }),
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      return { result: result.at(-1)?.result, launched };
    });

    const inherited = yield* launchPi();
    expect(inherited.launched[0]?.runtimeMode).toBe("auto-accept-edits");

    const requested = yield* launchPi("auto");
    expect(requested.result).toMatchObject({ code: "invalid_request" });
    expect(requested.launched).toHaveLength(0);

    const offered = yield* launchPi("approval-required");
    expect(offered.launched[0]?.runtimeMode).toBe("approval-required");
  }),
);

it.effect("a launch with a model its provider does not advertise creates no thread", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const providers: ServerProvider[] = ["claudeAgent", "codex"].map((driver) => ({
      instanceId: ProviderInstanceId.make(driver),
      driver: ProviderDriverKind.make(driver),
      enabled: true,
      installed: true,
      status: "ready",
      version: null,
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00Z",
      models: [
        driver === "claudeAgent"
          ? {
              slug: "claude-opus",
              name: "Opus",
              aliases: ["opus"],
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "effort",
                    label: "Effort",
                    type: "select",
                    options: [{ id: "medium", label: "Medium" }],
                  },
                ],
              },
            }
          : { slug: "gpt-5.4", name: "GPT", isCustom: false, capabilities: null },
      ],
      slashCommands: [],
      skills: [],
    }));
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      providers,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launchWith = (instanceId: string, model: string) =>
      toolkit
        .handle("t3_thread_launch", {
          title: "Fix",
          projectId,
          modelSelection: {
            instanceId: ProviderInstanceId.make(instanceId),
            model,
            options: [{ id: "effort", value: "medium" }],
          },
        })
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((result) => result.at(-1)?.result),
          Effect.provide(dependencies),
        );

    for (const [instanceId, model] of [
      ["claudeAgent", "claude-unadvertised"],
      ["codex", "opus"],
    ] as const) {
      expect(yield* launchWith(instanceId, model)).toMatchObject({
        code: "model_unavailable",
        message: expect.stringContaining(
          `Model ${model} is not advertised by provider ${instanceId}. Advertised models: `,
        ),
      });
    }
    expect(launched).toHaveLength(0);

    expect(yield* launchWith("claudeAgent", "Opus")).toMatchObject({
      modelSelection: {
        instanceId: "claudeAgent",
        model: "Opus",
        options: [{ id: "effort", value: "medium" }],
      },
    });
    expect(launched).toHaveLength(1);
  }),
);

it.effect("a launch retried with the same clientRequestId replays the first one", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launch = (clientRequestId: string | undefined) =>
      toolkit
        .handle("t3_thread_launch", {
          modelSelection: fixtureSelection,
          title: "Fix",
          projectId,
          message: "Fix the bug",
          ...(clientRequestId === undefined ? {} : { clientRequestId }),
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    yield* launch("fix-1");
    yield* launch("fix-1");
    yield* launch("fix-2");
    yield* launch(undefined);
    yield* launch(undefined);
    const ids = launched.map((input) => [input.commandId, input.threadId]);
    // The same key sends the same command and thread ids, which the launch
    // service replays instead of starting a second thread.
    expect(ids[0]).toEqual(ids[1]);
    expect(ids[0]?.[0]).toMatch(/^mcp:launch:[0-9a-f]{64}$/);
    expect(ids[2]).not.toEqual(ids[0]);
    // Without a key every launch is new.
    expect(ids[3]).not.toEqual(ids[4]);
  }),
);

it.effect("MCP staged writes edit only a candidate already in the active run manifest", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-hook-mcp-write-",
    });
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const harness = clientLaunchHarness({
      runtimeModeCeiling: "full-access",
      launched,
      workspaceRoot,
    });
    const threadId = ThreadId.make("thread-hook-mcp-write");
    const runId = "run-hook-mcp-write";
    const stageSession = HookStagingManager.makeHookStageSession({
      workspaceRoot,
      threadId,
      runId,
    });
    yield* Effect.promise(() => HookStagingManager.prepareHookStage(stageSession));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => HookStagingManager.forgetActiveHookStageSession(threadId, runId)),
    );
    const dependencies = Layer.mergeAll(
      harness.dependencies,
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () =>
          Effect.succeed({
            id: threadId,
            projectId: harness.projectId,
            deletedAt: null,
            archivedAt: null,
            activeRunId: runId,
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "auto",
            interactionMode: "default",
          } as never),
        getThreadSnapshotWindow: () =>
          Effect.succeed({
            projection: {
              thread: { id: threadId, projectId: harness.projectId, worktreePath: null },
              runs: [{ id: runId, status: "running" }],
            },
          } as never),
      }),
      Layer.mock(HookRegistry.HookRegistry)({
        runEvent: (input) =>
          Effect.succeed(
            (input.payload as { path?: string }).path === "src/blocked.ts"
              ? { allowed: false, messages: ["Use the approved staging path."] }
              : { allowed: true, messages: [] },
          ),
      }),
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "thread:test",
        thread: {
          threadId,
          providerSessionId: "provider-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const invokeStage = (input: {
      readonly environmentId: EnvironmentId;
      readonly path: string;
      readonly create: boolean;
    }) =>
      toolkit
        .handle("t3_hook_stage_file", input)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    const invokeWrite = (input: {
      readonly environmentId: EnvironmentId;
      readonly path: string;
      readonly contents: string;
    }) =>
      toolkit
        .handle("t3_hook_write_staged_file", input)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    const blocked = yield* invokeStage({
      environmentId: EnvironmentId.make("environment"),
      path: "src/blocked.ts",
      create: true,
    });
    expect(blocked.at(-1)?.result).toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("Use the approved staging path."),
    });
    expect(blocked.at(-1)?.result).toMatchObject({
      message: expect.stringContaining("Follow the hook rule and relevant AGENTS.md instructions"),
    });

    const staged = yield* invokeStage({
      environmentId: EnvironmentId.make("environment"),
      path: "src/new.ts",
      create: true,
    });
    expect(staged.at(-1)?.result).toMatchObject({
      candidatePath: expect.stringContaining("new.ts"),
    });
    const stageResult = staged.at(-1)?.result as { readonly candidatePath: string };

    const written = yield* invokeWrite({
      environmentId: EnvironmentId.make("environment"),
      path: "src/new.ts",
      contents: "export const value = 1;\n",
    });
    expect(written.at(-1)?.result).toMatchObject({
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(yield* fileSystem.readFileString(stageResult.candidatePath)).toBe(
      "export const value = 1;\n",
    );

    const rejected = yield* invokeWrite({
      environmentId: EnvironmentId.make("environment"),
      path: "src/outside.ts",
      contents: "escape",
    });
    expect(rejected.at(-1)?.result).toMatchObject({ code: "invalid_request" });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("Auto can draft only an inactive hook for the caller's project", () =>
  Effect.gen(function* () {
    const harness = clientLaunchHarness({ runtimeModeCeiling: "full-access", launched: [] });
    const threadId = ThreadId.make("thread-hook-draft");
    const created: Array<{
      readonly projectId: ProjectId;
      readonly script: string;
      readonly scope?: "project" | "all-projects" | undefined;
    }> = [];
    let active = true;
    let interactionMode: "default" | "plan" = "default";
    const dependencies = Layer.mergeAll(
      harness.dependencies,
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () =>
          Effect.succeed({
            id: threadId,
            projectId: harness.projectId,
            deletedAt: null,
            archivedAt: null,
            activeRunId: active ? "run-hook-draft" : null,
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "auto",
            interactionMode,
          } as never),
      }),
      Layer.mock(HookRegistry.HookRegistry)({
        createDraft: (input) =>
          Effect.sync(() => {
            created.push(input);
            return {
              ...input,
              id: "draft-1",
              scriptSha256: "a".repeat(64),
              status: "draft" as const,
              enabled: false,
              createdAt: 0,
            };
          }),
      }),
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "thread:test",
        thread: {
          threadId,
          providerSessionId: "provider-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const invoke = (projectId: ProjectId, scope?: "project" | "all-projects") =>
      toolkit
        .handle("t3_hook_draft", {
          environmentId: EnvironmentId.make("environment"),
          projectId,
          ...(scope === undefined ? {} : { scope }),
          name: "Guard",
          event: "before_file_write",
          script: 'return { decision: "allow" };',
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    expect((yield* invoke(harness.projectId)).at(-1)?.result).toMatchObject({
      scope: "all-projects",
      status: "draft",
      enabled: false,
    });
    expect((yield* invoke(harness.projectId, "project")).at(-1)?.result).toMatchObject({
      scope: "project",
      status: "draft",
      enabled: false,
    });
    expect((yield* invoke(ProjectId.make("project:other"))).at(-1)?.result).toMatchObject({
      code: "capability_denied",
    });
    interactionMode = "plan";
    expect((yield* invoke(harness.projectId)).at(-1)?.result).toMatchObject({
      code: "capability_denied",
    });
    interactionMode = "default";
    active = false;
    expect((yield* invoke(harness.projectId)).at(-1)?.result).toMatchObject({
      code: "parent_not_active",
    });
    expect(created).toHaveLength(2);
    expect(created[0]?.projectId).toBe(harness.projectId);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a launch key of any length or content gives a short id and never a defect", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launch = (clientRequestId: string) =>
      toolkit
        .handle("t3_thread_launch", {
          modelSelection: fixtureSelection,
          title: "Fix",
          projectId,
          clientRequestId,
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    // Percent-encoding would grow this six times; scratch folders are named from the id.
    yield* launch("\u00e9".repeat(256));
    expect(launched.map((input) => input.commandId)).toEqual([
      expect.stringMatching(/^mcp:launch:[0-9a-f]{64}$/),
    ]);

    const loneSurrogate = yield* launch("key-\ud800").pipe(Effect.exit);
    expect(Exit.isFailure(loneSurrogate) && Cause.hasDies(loneSurrogate.cause)).toBe(false);
    expect(launched).toHaveLength(1);
  }),
);

it.effect("a retried launch replays after the project loses its default model", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, modelSelection, projectDefaults, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launch = toolkit
      .handle("t3_thread_launch", {
        modelSelection: fixtureSelection,
        title: "Fix",
        projectId,
        clientRequestId: "fix-1",
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    yield* launch;
    projectDefaults.model = null;
    const retried = (yield* launch).at(-1)?.result;
    expect(retried).toMatchObject({ projectId, modelSelection });
    expect(launched.map((input) => input.threadId)).toEqual([
      launched[0]?.threadId,
      launched[0]?.threadId,
    ]);
  }),
);

it.effect("a launch binds only an existing checkout that is one of the project's worktrees", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-launch-worktree-" });
    const repo = path.join(root, "repo");
    const worktree = path.join(root, "feature");
    const outside = path.join(root, "outside");
    yield* fileSystem.makeDirectory(repo);
    yield* fileSystem.makeDirectory(outside);

    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      workspaceRoot: repo,
    });
    const git = yield* GitVcsDriver.GitVcsDriver.pipe(Effect.provide(dependencies));
    for (const args of [
      ["init", "-b", "main"],
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
      ["worktree", "add", "-b", "feature", worktree],
    ]) {
      yield* git.execute({ operation: "test.setupRepo", cwd: repo, args });
    }
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launchInto = (worktreePath: string) =>
      toolkit
        .handle("t3_thread_launch", {
          modelSelection: fixtureSelection,
          title: "Fix",
          projectId,
          workspaceStrategy: { type: "existing_worktree", worktreePath },
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    expect((yield* launchInto(worktree)).at(-1)?.result).toMatchObject({ projectId });
    expect((yield* launchInto(repo)).at(-1)?.result).toMatchObject({ projectId });
    for (const elsewhere of [outside, path.join(worktree, "..", "outside"), "/"]) {
      expect((yield* launchInto(elsewhere)).at(-1)?.result).toMatchObject({
        code: "invalid_request",
      });
    }
    expect(launched.map((launch) => launch.workspaceStrategy)).toEqual([
      { type: "existing_worktree", worktreePath: worktree },
      { type: "existing_worktree", worktreePath: repo },
    ]);

    yield* fileSystem.remove(worktree, { recursive: true });
    yield* fileSystem.makeDirectory(worktree);
    expect((yield* launchInto(worktree)).at(-1)?.result).toMatchObject({
      code: "invalid_request",
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a launch into a new worktree creates nothing when its base ref has no commit", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      checkWorktreeBase: ({ projectId, workspaceStrategy }) =>
        workspaceStrategy.type === "worktree" && workspaceStrategy.baseRef === "t3/renamed"
          ? Effect.fail(
              new ThreadLaunch.ThreadLaunchBaseRefError({
                projectId,
                projectTitle: "Client target",
                workspaceRoot: "/projects/client-target",
                baseRef: workspaceStrategy.baseRef,
              }),
            )
          : Effect.void,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launchFrom = (baseRef: string) =>
      toolkit
        .handle("t3_thread_launch", {
          modelSelection: fixtureSelection,
          title: "Fix",
          projectId,
          workspaceStrategy: { type: "worktree", baseRef, startFromOrigin: false },
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    const refused = (yield* launchFrom("t3/renamed")).at(-1)?.result;
    expect(refused).toMatchObject({ code: "invalid_request" });
    expect((refused as { message: string }).message).toContain(
      'Base ref "t3/renamed" does not resolve to a commit in project "Client target" (/projects/client-target). No thread was created.',
    );
    expect(launched).toHaveLength(0);

    expect((yield* launchFrom("main")).at(-1)?.result).toMatchObject({ projectId });
    expect(launched).toHaveLength(1);
  }),
);

it.effect("a worktree launch that omits startFromOrigin follows the new-worktree setting", () =>
  Effect.gen(function* () {
    const cases = [
      { setting: true, given: undefined, expected: true },
      { setting: false, given: undefined, expected: false },
      { setting: true, given: false, expected: false },
    ];
    for (const { setting, given, expected } of cases) {
      const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
      const checked: Array<ThreadLaunch.ThreadLaunchInput["workspaceStrategy"]> = [];
      const { projectId, dependencies } = clientLaunchHarness({
        runtimeModeCeiling: "auto",
        launched,
        newWorktreesStartFromOrigin: setting,
        checkWorktreeBase: ({ workspaceStrategy }) =>
          Effect.sync(() => {
            checked.push(workspaceStrategy);
          }),
      });
      const toolkit = yield* ProjectToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
            Layer.provide(dependencies),
          ),
        ),
      );
      yield* toolkit
        .handle("t3_thread_launch", {
          modelSelection: fixtureSelection,
          title: "Fix",
          projectId,
          workspaceStrategy: {
            type: "worktree",
            baseRef: "main",
            ...(given === undefined ? {} : { startFromOrigin: given }),
          },
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

      const strategy = { type: "worktree", baseRef: "main", startFromOrigin: expected };
      expect(checked).toEqual([strategy]);
      expect(launched.map((launch) => launch.workspaceStrategy)).toEqual([strategy]);
    }
  }),
);

it.effect("a launch into a new worktree creates nothing when its branch collides", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      checkWorktreeBase: ({ projectId, workspaceStrategy }) =>
        Effect.fail(
          new ThreadLaunch.ThreadLaunchBranchConflictError({
            projectId,
            projectTitle: "Client target",
            branch: workspaceStrategy.branch ?? "",
            conflictingBranch: "werkstatt",
          }),
        ),
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const refused = (yield* toolkit
      .handle("t3_thread_launch", {
        modelSelection: fixtureSelection,
        title: "Fix",
        projectId,
        workspaceStrategy: { type: "worktree", baseRef: "main", branch: "werkstatt/baseline" },
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies))).at(-1)?.result;

    expect(refused).toMatchObject({
      code: "invalid_request",
      message:
        'Branch "werkstatt/baseline" cannot be created in project "Client target": branch "werkstatt" exists. No thread was created. Use a name that does not nest under or contain an existing branch, such as "werkstatt-baseline".',
    });
    expect(launched).toHaveLength(0);
  }),
);

it.effect("a launch into an unknown project says the project was not found", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { modelSelection, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    for (const workspaceStrategy of [
      undefined,
      { type: "worktree", baseRef: "main", startFromOrigin: false } as const,
    ]) {
      const result = yield* toolkit
        .handle("t3_thread_launch", {
          title: "Fix",
          message: "Fix the bug",
          projectId: ProjectId.make("current"),
          modelSelection,
          ...(workspaceStrategy === undefined ? {} : { workspaceStrategy }),
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      expect(result.at(-1)?.result).toMatchObject({
        code: "invalid_request",
        message: "The project was not found.",
      });
    }
    expect(launched).toHaveLength(0);
  }),
);

it.effect("a retried worktree launch replays after its base ref is gone", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const base = { exists: true };
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      checkWorktreeBase: ({ projectId, workspaceStrategy }) =>
        base.exists || workspaceStrategy.type !== "worktree"
          ? Effect.void
          : Effect.fail(
              new ThreadLaunch.ThreadLaunchBaseRefError({
                projectId,
                projectTitle: "Client target",
                workspaceRoot: "/projects/client-target",
                baseRef: workspaceStrategy.baseRef,
              }),
            ),
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launch = toolkit
      .handle("t3_thread_launch", {
        modelSelection: fixtureSelection,
        title: "Fix",
        projectId,
        clientRequestId: "fix-worktree",
        workspaceStrategy: { type: "worktree", baseRef: "feature", startFromOrigin: false },
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    yield* launch;
    base.exists = false;
    expect((yield* launch).at(-1)?.result).toMatchObject({ projectId });
    expect(launched.map((input) => input.threadId)).toEqual([
      launched[0]?.threadId,
      launched[0]?.threadId,
    ]);
  }),
);

it.effect("a client launches with the fallback for an exhausted default", () =>
  Effect.gen(function* () {
    const launched: ThreadLaunch.ThreadLaunchInput[] = [];
    const fallbackModel = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-6.1-sol",
      options: [{ id: "reasoningEffort", value: "medium" }],
    };
    const providers: ServerProvider[] = ["claudeAgent", "codex"].map((driver) => ({
      instanceId: ProviderInstanceId.make(driver),
      driver: ProviderDriverKind.make(driver),
      enabled: true,
      installed: true,
      status: "ready",
      version: null,
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00Z",
      models:
        driver === "codex"
          ? [
              {
                slug: "gpt-6.1-sol",
                name: "Sol",
                isCustom: false,
                capabilities: {
                  optionDescriptors: [
                    {
                      id: "reasoningEffort",
                      label: "Effort",
                      type: "select",
                      options: [{ id: "medium", label: "Medium" }],
                    },
                  ],
                },
              },
            ]
          : [],
      slashCommands: [],
      skills: [],
      ...(driver === "claudeAgent"
        ? {
            usageLimits: {
              checkedAt: "2026-01-01T00:00:00Z",
              windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 100 }],
            },
          }
        : {}),
    }));
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "full-access",
      launched,
      fallbackModel,
      providers,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const result = yield* toolkit
      .handle("t3_thread_launch", {
        projectId,
        title: "Fallback",
        modelSelection: fallbackModel,
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(result.at(-1)?.result).toMatchObject({
      modelSelection: fallbackModel,
    });
    expect(launched[0]?.modelSelection).toEqual(fallbackModel);
  }),
);

it.effect("an agent's clone is not cut off while git is still transferring", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mcp-clone-" });
    const destinationPath = path.join(parent, "repo");
    const started = yield* Deferred.make<void>();
    const transferred = yield* Deferred.make<void>();
    const { dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "full-access",
      launched: [],
    });
    const repositories = Repositories.layer.pipe(
      Layer.provide(
        Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
          resolveLink: () => undefined,
        }),
      ),
      Layer.provide(
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          invalidateRefs: () => Effect.void,
          // Like the real driver, the clone fails once it outlives the deadline it was given.
          execute: (input) =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(transferred)),
              Effect.as({
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: "",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              }),
              Effect.timeoutOrElse({
                duration: input.timeoutMs ?? Infinity,
                orElse: () =>
                  Effect.fail(
                    new GitCommandError({
                      operation: input.operation,
                      command: "git",
                      cwd: input.cwd,
                      detail: "Git command timed out.",
                    }),
                  ),
              }),
            ),
        }),
      ),
      Layer.provideMerge(dependencies),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(repositories)),
      ),
    );

    const clone = yield* toolkit
      .handle("t3_project_clone", { remoteUrl: "https://example.test/repo.git", destinationPath })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(repositories), Effect.forkChild);
    yield* Deferred.await(started);
    // A large repository over a slow link; agents' MCP calls get a far longer budget.
    yield* TestClock.adjust("10 minutes");
    yield* Deferred.succeed(transferred, undefined);

    expect((yield* Fiber.join(clone)).at(-1)?.result).toMatchObject({ cwd: destinationPath });
  }).pipe(Effect.provide(NodeServices.layer)),
);

const deletedProject = (id: ProjectId) => ({
  id,
  title: "client-target",
  workspaceRoot: "/projects/client-target",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  projectIcon: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: "2026-01-01T00:00:00.000Z",
});

it.effect("deleting a project through MCP also discards its clone record", () =>
  Effect.gen(function* () {
    const discarded: Array<ProjectId> = [];
    const harness = clientLaunchHarness({ runtimeModeCeiling: "full-access", launched: [] });
    const dependencies = Layer.merge(
      harness.dependencies,
      Layer.mergeAll(
        Layer.mock(Project.ProjectService)({
          delete: (input) => Effect.succeed(deletedProject(input.projectId)),
        }),
        Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({
          discard: (projectId) => Effect.sync(() => void discarded.push(projectId)),
        }),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );

    yield* toolkit
      .handle("t3_project_delete", { projectId: harness.projectId })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    expect(discarded).toEqual([harness.projectId]);
  }),
);

it.effect("an agent cannot delete the built-in scratch project, even with force", () =>
  Effect.gen(function* () {
    const deleted: Array<ProjectId> = [];
    const harness = clientLaunchHarness({ runtimeModeCeiling: "full-access", launched: [] });
    const dependencies = Layer.merge(
      harness.dependencies,
      Layer.mergeAll(
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: (projectId) => Effect.succeed(projectId === harness.projectId),
        }),
        Layer.mock(Project.ProjectService)({
          delete: (input) =>
            Effect.sync(() => {
              deleted.push(input.projectId);
              return deletedProject(input.projectId);
            }),
        }),
        Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ discard: () => Effect.void }),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );

    const refused = yield* toolkit
      .handle("t3_project_delete", { projectId: harness.projectId, force: true })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    expect(deleted).toEqual([]);
    expect(refused.at(-1)?.result).toMatchObject({
      code: "invalid_request",
      message: expect.stringMatching(/scratch|no project/i),
    });
  }),
);

it.effect("an update the project refuses tells the agent why", () =>
  Effect.gen(function* () {
    const harness = clientLaunchHarness({ runtimeModeCeiling: "full-access", launched: [] });
    const detail = "Project monograms must contain at most two characters.";
    const dependencies = Layer.merge(
      harness.dependencies,
      Layer.mock(Project.ProjectService)({
        update: (input) =>
          Effect.fail(new Project.ProjectInvalidError({ projectId: input.projectId, detail })),
      }),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );

    const refused = yield* toolkit
      .handle("t3_project_update", {
        projectId: harness.projectId,
        projectIcon: { kind: "monogram", text: "ABC", color: "blue" },
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    expect(refused.at(-1)?.result).toMatchObject({ code: "invalid_request", message: detail });
  }),
);

it.effect("an agent launch needs an explicit advertised selection and accepts any model", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "full-access",
      launched,
      providers: [
        {
          instanceId: ProviderInstanceId.make("codex"),
          models: [
            {
              slug: "gpt-6.1-terra",
              name: "Terra",
              capabilities: {
                optionDescriptors: [
                  {
                    id: "reasoningEffort",
                    label: "Effort",
                    type: "select",
                    options: [{ id: "medium" }],
                  },
                ],
              },
            },
          ],
        },
        {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          models: [
            {
              slug: "claude-opus-5-5",
              name: "Opus",
              aliases: ["planning-alias"],
              capabilities: {
                optionDescriptors: [
                  { id: "effort", label: "Effort", type: "select", options: [{ id: "medium" }] },
                ],
              },
            },
          ],
        },
      ] as unknown as ServerProvider[],
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const inherited = yield* toolkit
      .handle("t3_thread_launch", { title: "Worker", projectId })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(inherited.at(-1)?.result).toMatchObject({ code: "invalid_request" });
    expect(launched).toHaveLength(0);
    const allowed = yield* toolkit
      .handle("t3_thread_launch", {
        title: "Worker",
        projectId,
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-6.1-terra",
          options: [{ id: "reasoningEffort", value: "medium" }],
        },
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(allowed.at(-1)?.result).toMatchObject({ projectId });
    expect(launched).toHaveLength(1);
    const opusExecution = yield* toolkit
      .handle("t3_thread_launch", {
        title: "Worker",
        projectId,
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "planning-alias",
          options: [{ id: "effort", value: "medium" }],
        },
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(opusExecution.at(-1)?.result).toMatchObject({ projectId });
    expect(launched[1]?.agentExecutionIntent).toEqual({
      modelSelection: {
        instanceId: "claudeAgent",
        model: "planning-alias",
        options: [{ id: "effort", value: "medium" }],
      },
    });
    const badEffort = yield* toolkit
      .handle("t3_thread_launch", {
        title: "Worker",
        projectId,
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-6.1-terra",
          options: [{ id: "reasoningEffort", value: "invalid" }],
        },
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(badEffort.at(-1)?.result).toMatchObject({ code: "invalid_request" });
    expect(launched).toHaveLength(2);
    const planning = yield* toolkit
      .handle("t3_thread_launch", {
        title: "Plan",
        projectId,
        interactionMode: "plan",
        planningPurpose: "Design the bounded retry policy",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-5-5",
          options: [{ id: "effort", value: "medium" }],
        },
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(planning.at(-1)?.result).toMatchObject({ projectId });
    expect(launched[2]?.interactionMode).toBe("plan");
    expect(launched[2]?.agentExecutionIntent).toMatchObject({
      interactionMode: "plan",
      planningPurpose: "Design the bounded retry policy",
      modelSelection: { model: "claude-opus-5-5", options: [{ id: "effort", value: "medium" }] },
    });
  }),
);

it.effect.each([
  { name: "omitted selection", selection: undefined },
  {
    name: "unsupported effort",
    selection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-6.1-terra",
      options: [{ id: "reasoningEffort", value: "unsupported" }],
    },
  },
])("rejects $name before launching", ({ selection }) =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "full-access",
      launched,
      providers: [fixtureProvider],
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const result = yield* toolkit
      .handle("t3_thread_launch", {
        title: "Worker",
        projectId,
        ...(selection === undefined ? {} : { modelSelection: selection }),
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(result.at(-1)?.result).toMatchObject({ code: "invalid_request" });
    expect(launched).toHaveLength(0);
  }),
);

describe("t3_thread_launch from a delegated child", () => {
  const parentThreadId = ThreadId.make("thread:parent");
  const childThreadId = ThreadId.make("thread:predecessor");
  const taskId = NodeId.make("node:task");
  const childShell = {
    lineage: { rootThreadId: parentThreadId, parentThreadId, relationshipToParent: "subagent" },
    forkedFrom: { type: "node", nodeId: taskId },
  } as unknown as Partial<OrchestrationV2ThreadShell>;
  const openTask = (overrides: Partial<HandoffTask> = {}): HandoffTask => ({
    id: taskId,
    origin: "app_owned",
    childThreadId,
    result: null,
    completedAt: null,
    startedAt: null,
    ...overrides,
  });
  const launchFrom = (input: {
    readonly callerShell?: Partial<OrchestrationV2ThreadShell>;
    readonly tasks: Array<HandoffTask>;
    readonly keys: ReadonlyArray<string>;
    /** Workspace fields a child's successor ignores. */
    readonly workspace?: {
      readonly projectId?: ProjectId;
      readonly scratch?: boolean;
      readonly workspaceStrategy?: {
        readonly type: "worktree";
        readonly baseRef: string;
        readonly startFromOrigin: boolean;
      };
    };
  }) =>
    Effect.gen(function* () {
      const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
      const dispatched: Array<{ readonly type: string }> = [];
      const prepared: Array<ThreadLaunch.ThreadLaunchPreparationInput> = [];
      const { projectId, modelSelection, dependencies } = clientLaunchHarness({
        runtimeModeCeiling: "full-access",
        launched,
        callerThreadId: childThreadId,
        ...(input.callerShell === undefined ? {} : { callerShell: input.callerShell }),
        tasks: input.tasks,
        dispatched,
        prepared,
      });
      const toolkit = yield* ProjectToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
            Layer.provide(dependencies),
          ),
        ),
      );
      const results: Array<unknown> = [];
      for (const key of input.keys)
        results.push(
          (yield* toolkit
            .handle("t3_thread_launch", {
              projectId,
              title: "Successor",
              message: "Continue the migration.",
              modelSelection,
              clientRequestId: key,
              ...input.workspace,
            })
            .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies))).at(-1)?.result,
        );
      return {
        results,
        launched,
        handoffs: dispatched.filter((command) => command.type === "delegated_task.handoff"),
        prepared,
      };
    });

  it.effect("an open task's child hands it off instead of launching a top-level thread", () =>
    Effect.gen(function* () {
      const tasks = [openTask()];
      const { launched, handoffs } = yield* launchFrom({
        callerShell: childShell,
        tasks,
        keys: ["one"],
      });
      expect(handoffs).toHaveLength(1);
      // The successor's agent-started runs need the selection the launch chose.
      expect(handoffs[0]).toMatchObject({
        agentExecutionIntent: { modelSelection: fixtureSelection },
      });
      expect(launched).toHaveLength(0);
      expect(tasks[0]?.childThreadId).not.toBe(childThreadId);
    }),
  );

  it.effect("R4: a successor ignores another project, scratch and workspace strategy", () =>
    Effect.gen(function* () {
      const tasks = [openTask()];
      const { results, launched, handoffs, prepared } = yield* launchFrom({
        callerShell: childShell,
        tasks,
        keys: ["one", "one"],
        workspace: {
          projectId: ProjectId.make("project:other"),
          scratch: true,
          workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: false },
        },
      });
      // The successor stays in the caller's project and checkout, so the parent gets its result.
      expect(handoffs).toHaveLength(1);
      expect(handoffs[0]).not.toHaveProperty("workspaceStrategy");
      expect(launched).toHaveLength(0);
      expect(prepared).toEqual([]);
      expect(tasks[0]?.childThreadId).not.toBe(childThreadId);
      for (const result of results)
        expect(result).toMatchObject({
          threadId: tasks[0]?.childThreadId,
          workspace: "same as caller; projectId/scratch/workspaceStrategy ignored",
        });
    }),
  );

  it.effect("a top-level caller gets a top-level thread", () =>
    Effect.gen(function* () {
      const { launched, handoffs } = yield* launchFrom({ tasks: [openTask()], keys: ["one"] });
      expect(handoffs).toHaveLength(0);
      expect(launched).toHaveLength(1);
    }),
  );

  it.effect("a child whose parent is in another environment is not rebound", () =>
    Effect.gen(function* () {
      // A remotely delegated thread is top-level here: no subagent lineage and no task node.
      const { launched, handoffs } = yield* launchFrom({
        callerShell: {
          lineage: {
            rootThreadId: childThreadId,
            parentThreadId: null,
            relationshipToParent: null,
          },
          forkedFrom: null,
        } as unknown as Partial<OrchestrationV2ThreadShell>,
        tasks: [openTask()],
        keys: ["one"],
      });
      expect(handoffs).toHaveLength(0);
      expect(launched).toHaveLength(1);
    }),
  );

  it.effect("a completed or cancelled child's launch is a plain top-level launch", () =>
    Effect.gen(function* () {
      for (const ended of [
        openTask({ result: "done" }),
        openTask({ cancelledRunId: RunId.make("run:cancelled") }),
      ]) {
        const { launched, handoffs } = yield* launchFrom({
          callerShell: childShell,
          tasks: [ended],
          keys: ["one"],
        });
        expect(handoffs).toHaveLength(0);
        expect(launched).toHaveLength(1);
      }
    }),
  );

  it.effect("a second launch from the same old child does not rebind again", () =>
    Effect.gen(function* () {
      const tasks = [openTask()];
      const { launched, handoffs } = yield* launchFrom({
        callerShell: childShell,
        tasks,
        keys: ["one", "two"],
      });
      expect(handoffs).toHaveLength(1);
      expect(launched).toHaveLength(1);
    }),
  );
});
