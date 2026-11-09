import { McpAttachmentInput } from "../attachment/input.ts";
import {
  NonNegativeInt,
  ModelSelection,
  TrimmedNonEmptyString,
  ThreadId,
  RunId,
  OrchestrationV2DelegatedFrom,
  OrchestrationV2RunStatus,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  RuntimeMode,
  ProviderInteractionMode,
  Project,
  ProjectCreatePayload,
  ProjectUpdatePayload,
  ProjectId,
  OrchestratorMcpClientRequestId,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
  HookDraftInput,
  HookTestInput,
  HookTestResult,
  HookResourceInput,
  HookWorkInput,
  AgentPingInput,
  HookResourceResult,
  HookDefinition,
  HookStageFileInput,
  HookStageFileResult,
  HookWriteStagedFileInput,
  HookWriteStagedFileResult,
} from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as DocumentText from "../../../provider/DocumentText.ts";
import * as ServerConfig from "../../../config.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProjectCloneTracker from "../../../project/ProjectCloneTracker.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SourceControlRepositoryService from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as HookRegistry from "../../../hooks/HookRegistry.ts";
import * as HookAutomation from "../../../hooks/HookAutomation.ts";

const shared = {
  success: Project,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    SecureRandom.SecureRandom,
  ],
};
const HookCapabilitiesTool = Tool.make("t3_hook_capabilities", {
  ...shared,
  description:
    "Read the host's hook events, actual enforcement boundaries and provider bridge setup before proposing a safeguard. Reserved or unavailable events do not run. Native provider hooks require separate human trust and are guardrails with coverage gaps.",
  parameters: Tool.EmptyParams,
  success: Schema.Json,
}).annotate(Tool.Readonly, true);
const HookTestTool = Tool.make("t3_hook_test", {
  ...shared,
  description:
    "Test one exact hook script against a harmless supplied event payload in the restricted hook runtime. Returns its SHA-256 and decision; performs no protected operation and changes no policy. Test allowed, denied and invalid-input cases before proposing an inactive draft. A simulation is not proof of native interception or external delivery.",
  parameters: HookTestInput,
  success: HookTestResult,
  dependencies: [...shared.dependencies, HookRegistry.HookRegistry],
}).annotate(Tool.Destructive, false);
const ProjectListTool = Tool.make("t3_project_list", {
  ...shared,
  description: "List projects. Pages can shift.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  }),
  success: Schema.Struct({
    projects: Schema.Array(Project),
    nextCursor: Schema.NullOr(NonNegativeInt),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ProjectReadTool = Tool.make("t3_project_read", {
  ...shared,
  description: "Read one project: workspace and saved scripts.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: ProjectId,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ProjectCreateTool = Tool.make("t3_project_create", {
  ...shared,
  description:
    "Register a project folder. `createWorkspaceRootIfMissing` creates it; a registered folder is rejected. No `workspaceRoot`: makes a git repo from `title` with README, icon, first commit (`commitError` on failure; project still exists). Clone first with `t3_project_clone` if needed.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...ProjectCreatePayload.fields,
    workspaceRoot: Schema.optional(ProjectCreatePayload.fields.workspaceRoot),
  }),
  success: Schema.Struct({ ...Project.fields, commitError: Schema.optional(Schema.String) }),
  dependencies: [...shared.dependencies, ManagedProjectFolders.ManagedProjectFolders],
}).annotate(Tool.Destructive, true);
const ProjectUpdateTool = Tool.make("t3_project_update", {
  ...shared,
  description: "Update one project's settings. Omitted fields are unchanged.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: ProjectId,
    ...ProjectUpdatePayload.fields,
  }),
}).annotate(Tool.Destructive, true);
const ProjectDeleteTool = Tool.make("t3_project_delete", {
  ...shared,
  description: "Delete one project. Nonempty needs `force: true`. Folder on disk stays.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: ProjectId,
    force: Schema.optionalKey(Schema.Boolean),
  }),
  dependencies: [...shared.dependencies, ProjectCloneTracker.ProjectCloneTracker],
}).annotate(Tool.Destructive, true);
const ProjectCloneTool = Tool.make("t3_project_clone", {
  ...shared,
  description:
    "Clone a repository (`destinationPath` new or empty). Register after with `t3_project_create`, with the same `environmentId`.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...SourceControlCloneRepositoryInput.fields,
  }),
  success: SourceControlCloneRepositoryResult,
  dependencies: [
    ...shared.dependencies,
    SourceControlRepositoryService.SourceControlRepositoryService,
  ],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);
const UserPingTool = Tool.make("t3_user_ping", {
  ...shared,
  description:
    "Ask for the human owner's attention from this active thread, even when routine thread updates are muted. Use your judgement for needed input, an exhausted recovery, or an important update the human should see. Give a clear title and concrete reason; keep routine orchestration and agent-to-agent completions silent. Reuse key for retries. T3 deduplicates and limits pings per thread; device/global notification settings still apply. This records a request, not proof of push delivery.",
  parameters: AgentPingInput,
  success: Schema.Struct({ recorded: Schema.Boolean }),
  dependencies: [...shared.dependencies, HookAutomation.HookAutomation],
}).annotate(Tool.Destructive, true);
const HookWorkTool = Tool.make("t3_hook_work", {
  ...shared,
  description:
    "Track a concrete unfinished work obligation for this thread. Register with an expectedSeconds deadline; report meaningful progress, an explicit wait, completion or cancellation. A missed deadline opens a durable incident. Only an approved thread_stalled hook can request bounded recovery; human Stop, questions and queues prevent it. Healthy long jobs should use their actual expected deadline.",
  parameters: HookWorkInput,
  success: Schema.Struct({ recorded: Schema.Boolean }),
  dependencies: [...shared.dependencies, HookAutomation.HookAutomation],
}).annotate(Tool.Destructive, true);
const HookResourceTool = Tool.make("t3_hook_resource", {
  ...shared,
  description:
    "Manage this thread's computer-use time estimate. Before computer use, acquire with your own estimateSeconds. At expiry decide whether to renew with a fresh estimate or end the native backend session, then action=end. Set backendEnded=true only after the backend acknowledges release. A lease does not grant task permission or prove native interception. action=status reads the lease.",
  parameters: HookResourceInput,
  success: HookResourceResult,
  dependencies: [...shared.dependencies, HookAutomation.HookAutomation],
}).annotate(Tool.Destructive, true);
const HookEventTool = Tool.make("t3_hook_event", {
  ...shared,
  description:
    "Provider hook bridge for this active thread. Emit a before_tool or after_tool event with toolName and toolInput; returns Codex hook output. This only enforces calls routed through a human-trusted provider hook. Ordinary agents must not use it to claim an action was executed or verified.",
  parameters: Schema.Struct({
    event: Schema.Literals(["before_tool", "after_tool"]),
    toolName: TrimmedNonEmptyString,
    toolInput: Schema.optional(Schema.Json),
  }),
  success: Schema.Json,
  dependencies: [...shared.dependencies, HookAutomation.HookAutomation],
});
const HookDraftTool = Tool.make("t3_hook_draft", {
  ...shared,
  description:
    "Propose an inactive hook for exact human review. First read t3_hook_capabilities for actual events and enforcement limits, then test the exact script with t3_hook_test using allowed, denied and invalid payloads. Default scope is all-projects; use project when requested. A script starts with // Description:. Native tool guards require a separately human-trusted provider bridge and have coverage gaps; reserved events do not run. Timers and bounded recovery preserve Stop, questions, queues, permissions and usage limits. Present the complete script, event, scope, tests and returned SHA-256. Only the human may approve or enable it in Hooks and safeguards. Agents cannot approve, enable, disable or replace active hooks.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...HookDraftInput.fields,
  }),
  success: HookDefinition,
  dependencies: [...shared.dependencies, HookRegistry.HookRegistry],
}).annotate(Tool.Destructive, true);
const HookStageFileTool = Tool.make("t3_hook_stage_file", {
  ...shared,
  description:
    "For a Codex run with an available staging session, prepare a project file for staged editing. Pass a workspace-relative path and create:false for an existing file or create:true for a new file. T3 records the original hash and returns the candidate path. Write candidate contents with t3_hook_write_staged_file. Installation requires an explicit install-staged-files turn-end hook decision and successful manifest and original-hash checks. Active hooks may deny staging or installation.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...HookStageFileInput.fields,
  }),
  success: HookStageFileResult,
  dependencies: [
    ...shared.dependencies,
    FileSystem.FileSystem,
    Path.Path,
    ServerConfig.ServerConfig,
    ServerSettings.ServerSettingsService,
    HookRegistry.HookRegistry,
  ],
}).annotate(Tool.Destructive, true);
const HookWriteStagedFileTool = Tool.make("t3_hook_write_staged_file", {
  ...shared,
  description:
    "Write complete candidate contents for a file prepared with t3_hook_stage_file. This writes only the manifest-listed candidate under this run's staging new/ directory; it never writes the project source file. Use this for an available staged-edit session; it does not change the selected permission mode.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...HookWriteStagedFileInput.fields,
  }),
  success: HookWriteStagedFileResult,
  dependencies: [
    ...shared.dependencies,
    FileSystem.FileSystem,
    Path.Path,
    ServerConfig.ServerConfig,
    ServerSettings.ServerSettingsService,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    HookRegistry.HookRegistry,
  ],
}).annotate(Tool.Destructive, true);
const ThreadLaunchTool = Tool.make("t3_thread_launch", {
  ...shared,
  description:
    "Create one new top-level thread, bound to its workspace before the agent starts. Task in `message`. Omit `projectId`, model and modes to inherit yours (outside a thread, pass `projectId` or `scratch`); modes cannot exceed yours. After an error or lost reply, retry with the same `clientRequestId`. Follow it with `t3_thread_read` or `t3_thread_wait`. Mention it with its `link`.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: Schema.optional(ProjectId),
    scratch: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "No project: a new Scratch folder. Not with `projectId` or `workspaceStrategy`.",
      }),
    ),
    title: TrimmedNonEmptyString,
    modelSelection: Schema.optional(ModelSelection),
    runtimeMode: Schema.optional(RuntimeMode),
    interactionMode: Schema.optional(ProviderInteractionMode),
    workspaceStrategy: Schema.optional(
      OrchestrationV2ThreadLaunchWorkspaceStrategy.annotate({
        description:
          "'worktree': new checkout from `baseRef`. Honor a requested base. Otherwise, independent work uses the default branch as `remote/branch` (e.g. `origin/main`) with `startFromOrigin: true`; with no remote, use the local default branch. Required unpublished commits and dependent or stacked work use their local base with `startFromOrigin: false`. 'existing_worktree': bind `worktreePath`, a project worktree. 'root': project checkout, the default, not your worktree. Uncommitted edits are not copied.",
      }),
    ),
    message: Schema.optional(
      Schema.String.check(Schema.isMaxLength(120000)).annotate({
        description: "First prompt. Omit it and `attachments` for idle.",
      }),
    ),
    attachments: Schema.optional(Schema.Array(McpAttachmentInput).check(Schema.isMaxLength(8))),
    clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
    /** Set by a linked environment launching its agent's delegated task here; ignored otherwise. */
    delegatedFrom: Schema.optional(OrchestrationV2DelegatedFrom),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    link: Schema.optional(Schema.String),
    projectId: ProjectId,
    modelSelection: ModelSelection,
    runId: Schema.NullOr(RunId),
    status: Schema.NullOr(OrchestrationV2RunStatus),
  }),
  dependencies: [
    ...shared.dependencies,
    ThreadLaunchService.ThreadLaunchService,
    ManagedProjectFolders.ManagedProjectFolders,
    GitVcsDriver.GitVcsDriver,
    FileSystem.FileSystem,
    ServerConfig.ServerConfig,
    ServerSettings.ServerSettingsService,
    ProviderRegistry.ProviderRegistry,
    DocumentText.DocumentText,
    Digest.Digest,
  ],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const ProjectToolkit = Toolkit.make(
  ThreadLaunchTool,
  ProjectListTool,
  ProjectReadTool,
  HookDraftTool,
  HookCapabilitiesTool,
  HookTestTool,
  HookResourceTool,
  HookWorkTool,
  UserPingTool,
  HookEventTool,
  HookStageFileTool,
  HookWriteStagedFileTool,
  ProjectCreateTool,
  ProjectUpdateTool,
  ProjectDeleteTool,
  ProjectCloneTool,
);
