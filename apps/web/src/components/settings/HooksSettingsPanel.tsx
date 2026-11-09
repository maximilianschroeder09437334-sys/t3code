import { HookRuntimeStatus } from "./HookRuntimeStatus";
import { HookBuilder } from "./HookBuilder";
import { HookRemoveControl } from "./HookRemoveControl";
import { useServerConfigs } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  AuthSettingsWriteScope,
  HookEvent,
  type HookDefinition,
  type ProjectId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useSettingsScope } from "./SettingsScopeContext";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { resolveHookSetupConfiguration } from "./hookSetup";
import { hookSummary } from "@t3tools/shared/hookSummary";
import {
  hookEnvironmentRepresentatives,
  hookProjectsForScope,
  hooksInScope,
  visibleHookProjects,
} from "./hookProjects";
import { useEnvironmentQuery } from "~/state/query";
import { hooksList, hookApprove, hookSetEnabled, hookUpdateDraft, hookDelete } from "~/state/hooks";
import { readEnvironmentScope } from "~/state/session";
import { requestConfirmDialog } from "~/confirmDialog";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useComposerDraftStore } from "~/composerDraftStore";
import { newMessageId, newThreadId } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentServerConfigsAtom } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { buildThreadRouteParams } from "~/threadRoutes";

const hookSetupPrompt = (scope: "all-projects" | "project") =>
  `Help create a hook using t3-hook-authoring when available. Ask only missing behavior and scope decisions. Default scope: ${scope}. First read t3_hook_capabilities for actual host events, coverage and provider requirements. Use the builder's When, Check, Repair, Verify and Limits structure, or expert JavaScript. T3-managed file writes, provider starts, branch pushes, browser mutations and agent t3_thread_send handoffs have specific managed boundaries. Registered work obligations and resource estimates have durable host timers; Stop, questions, queues, permissions and usage limits win. Native tools require a separately human-trusted provider bridge, with coverage gaps and fail-open provider errors. Do not claim actual backend release from an agent's attestation. Reserved unavailable events never run. Test the exact script with t3_hook_test for allowed, denied and invalid-input cases, then use t3_hook_draft to save an inactive version. Start with // Description:. Present the full script, event, scope, test limits and SHA-256. Ask the human to review and approve the exact version in Hooks and safeguards. Never approve, enable, disable or replace live hooks for them. Routine agent communication stays muted; t3_user_ping is for important human attention, subject to device settings.`;

const EVENT_LABELS: Readonly<Record<HookDefinition["event"], string>> = {
  before_file_write: "Before T3 file write",
  before_provider_turn_start: "Before provider starts",
  turn_end: "After agent turn",
  before_github_push: "Before T3 branch push",
  before_browser_action: "Before T3 browser mutation",
  before_tool: "Before provider tool",
  after_tool: "After provider tool",
  resource_start: "Before managed resource use",
  resource_expired: "Resource estimate expired",
  resource_end: "Resource released",
  thread_stalled: "Work obligation stalled",
  usage_updated: "Reported usage changed",
  before_app_launch: "Before registered app launch",
  after_app_launch: "After registered app launch",
  before_handoff: "Before structured handoff",
  handoff_completed: "After verified handoff",
};

export function HooksSettingsPanel() {
  const { scope, groups } = useSettingsScope();
  const projects = hookProjectsForScope(scope, groups);
  const visibleProjects = visibleHookProjects(scope, groups, projects);
  const environments = hookEnvironmentRepresentatives([...visibleProjects, ...projects]);

  if (projects.length === 0) {
    return (
      <SettingsPageContainer>
        <SettingsSection id="hooks-manager" title="Hooks and safeguards">
          <SettingsRow
            title={scope.kind === "unavailable" ? "Selection unavailable" : "No projects available"}
            description={
              scope.kind === "unavailable"
                ? scope.message
                : "Add or reconnect a project to view its hooks."
            }
            role="status"
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }
  return (
    <SettingsPageContainer>
      {environments.map((project, index) => (
        <HookProjectPanel
          key={`environment:${project.environmentId}`}
          project={project}
          sectionId={index === 0 ? "hooks-manager" : `hooks-manager-${index}`}
          showIntro={index === 0}
          panelScope="all-projects"
          onChanged={() => {
            for (const member of projects) {
              if (member.environmentId === project.environmentId) {
                appAtomRegistry.refresh(
                  hooksList({
                    environmentId: member.environmentId,
                    input: { projectId: member.id, supportedEvents: HookEvent.literals },
                  }),
                );
              }
            }
          }}
        />
      ))}
      {visibleProjects.map((project, index) => (
        <HookProjectPanel
          key={`project:${project.physicalProjectKey}`}
          project={project}
          sectionId={`hooks-project-${index}`}
          showIntro={false}
          panelScope="project"
          onChanged={() => {
            for (const member of projects) {
              if (member.environmentId === project.environmentId) {
                appAtomRegistry.refresh(
                  hooksList({
                    environmentId: member.environmentId,
                    input: { projectId: member.id, supportedEvents: HookEvent.literals },
                  }),
                );
              }
            }
          }}
        />
      ))}
    </SettingsPageContainer>
  );
}

export function HookProjectPanel({
  project,
  panelScope,
  onChanged,
  sectionId,
  showIntro,
}: {
  project: SidebarProjectGroupMember;
  panelScope: "all-projects" | "project";
  onChanged: () => void;
  sectionId: string;
  showIntro: boolean;
}) {
  const navigate = useNavigate();
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [startingHook, setStartingHook] = useState(false);
  const [builderOpen, setBuilderOpen] = useState(false);
  const hookStartInFlight = useRef(false);
  const environmentId = project.environmentId;
  const projectId = project.id as ProjectId;
  const listAtom =
    environmentId !== undefined && projectId !== undefined
      ? hooksList({ environmentId, input: { projectId, supportedEvents: HookEvent.literals } })
      : null;
  const query = useEnvironmentQuery(listAtom);
  const approve = useAtomCommand(hookApprove, "approve hook draft");
  const setEnabled = useAtomCommand(hookSetEnabled, "change hook status");
  const updateDraft = useAtomCommand(hookUpdateDraft, "edit hook draft");
  const removeHook = useAtomCommand(hookDelete, "remove disabled hook");
  const serverConfigs = useServerConfigs();
  const removalSupported =
    environmentId !== undefined &&
    serverConfigs.get(environmentId)?.environment.capabilities.hookRemoval === true;
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftScript, setDraftScript] = useState("");

  const startHookSetup = async () => {
    if (!project || hookStartInFlight.current) return;
    hookStartInFlight.current = true;
    setStartingHook(true);
    try {
      const config = appAtomRegistry.get(environmentServerConfigsAtom).get(project.environmentId);
      if (!config) throw new Error("Reconnect the selected environment and try again.");
      const drafts = useComposerDraftStore.getState();
      const existingDraft = drafts.getDraftSessionByProjectRef(
        scopeProjectRef(project.environmentId, project.id),
      );
      const composer = existingDraft ? drafts.getComposerDraft(existingDraft.draftId) : null;
      const draftSelection =
        composer?.modelSelectionExplicit && composer.activeProvider
          ? (composer.modelSelectionByProvider[composer.activeProvider] ?? null)
          : null;
      const { modelSelection, runtimeMode } = resolveHookSetupConfiguration({
        draftSelection,
        project,
        settings: config.settings,
        providers: config.providers,
        stickyProvider: drafts.stickyActiveProvider,
        stickySelection: drafts.stickyActiveProvider
          ? drafts.stickyModelSelectionByProvider[drafts.stickyActiveProvider]
          : undefined,
      });
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      const title = "Create a hook";
      const result = await startTurn({
        environmentId: project.environmentId,
        input: {
          threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: hookSetupPrompt(panelScope),
            attachments: [],
          },
          modelSelection,
          runtimeMode,
          interactionMode: "default",
          bootstrap: {
            createThread: {
              projectId: project.id,
              title,
              modelSelection,
              runtimeMode,
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt,
            },
          },
          createdAt,
        },
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        throw squashAtomCommandFailure(result);
      }
      try {
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(project.environmentId, threadId)),
        });
      } catch {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Hook setup started",
            description:
              "The chat started but could not be opened. Find Create a hook in the sidebar.",
          }),
        );
      }
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not start hook setup",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      hookStartInFlight.current = false;
      setStartingHook(false);
    }
  };

  const act = async (hook: HookDefinition, action: "approve" | "toggle") => {
    if (environmentId === undefined || projectId === undefined || busyId !== null) return;
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Hook access denied",
          description: "This environment does not grant settings write access.",
        }),
      );
      return;
    }
    if (action === "approve") {
      const confirmed = await requestConfirmDialog(
        `Approve this exact script for ${hook.scope === "all-projects" ? "all projects in this environment" : "this project"}? SHA-256: ${hook.scriptSha256}`,
      );
      if (!confirmed) return;
    }
    setBusyId(hook.id);
    const result =
      action === "approve"
        ? await approve({
            environmentId,
            input: {
              projectId,
              hookId: hook.id,
              reviewedSha256: hook.scriptSha256,
              reviewedEvent: hook.event,
              reviewedScope: hook.scope ?? "project",
            },
          })
        : await setEnabled({
            environmentId,
            input: { projectId, hookId: hook.id, enabled: !hook.enabled },
          });
    setBusyId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: action === "approve" ? "Could not approve hook" : "Could not update hook",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
      return;
    }
    onChanged();
  };

  const remove = async (hook: HookDefinition) => {
    if (
      environmentId === undefined ||
      busyId !== null ||
      hook.enabled ||
      !removalSupported ||
      !readEnvironmentScope(environmentId, AuthSettingsWriteScope)
    )
      return;
    const confirmed = await requestConfirmDialog(
      `Remove "${hook.name}"? It is disabled. A recovery copy of this exact version will be kept.`,
    );
    if (!confirmed || !readEnvironmentScope(environmentId, AuthSettingsWriteScope)) return;
    setBusyId(hook.id);
    const result = await removeHook({
      environmentId,
      input: { projectId, hookId: hook.id, expectedSha256: hook.scriptSha256 },
    });
    setBusyId(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result))
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not remove hook",
            description: String(squashAtomCommandFailure(result)),
          }),
        );
      return;
    }
    if (editingId === hook.id) setEditingId(null);
    onChanged();
  };

  const saveDraft = async (hook: HookDefinition) => {
    if (environmentId === undefined || projectId === undefined || busyId !== null) return;
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Hook access denied",
          description: "This environment does not grant settings write access.",
        }),
      );
      return;
    }
    setBusyId(hook.id);
    const result = await updateDraft({
      environmentId,
      input: { projectId, hookId: hook.id, script: draftScript },
    });
    setBusyId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not save hook draft",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
      return;
    }
    setEditingId(null);
    onChanged();
  };

  const hooks = hooksInScope(query.data ?? [], panelScope).filter((hook) => {
    const needle = search.trim().toLowerCase();
    return (
      needle.length === 0 ||
      hook.name.toLowerCase().includes(needle) ||
      (hookSummary(hook)?.toLowerCase().includes(needle) ?? false) ||
      EVENT_LABELS[hook.event].toLowerCase().includes(needle) ||
      hook.status.includes(needle) ||
      hook.scriptSha256.includes(needle)
    );
  });

  return (
    <SettingsSection
      id={sectionId}
      title={
        panelScope === "all-projects"
          ? `All projects · ${project.environmentLabel ?? "Environment"}`
          : `${project.title} · ${project.environmentLabel ?? "Environment"}`
      }
      headerAction={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Input
            aria-label="Search hooks"
            placeholder="Search hooks"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="w-full sm:w-48"
          />
          <Button variant="outline" size="sm" onClick={() => setBuilderOpen(!builderOpen)}>
            {builderOpen ? "Close builder" : "Build a hook"}
          </Button>
          <Button size="sm" disabled={startingHook} onClick={() => void startHookSetup()}>
            {startingHook ? "Starting…" : "Add new hook"}
          </Button>
        </div>
      }
    >
      {environmentId !== undefined ? (
        <HookRuntimeStatus environmentId={environmentId} projectId={projectId} />
      ) : null}
      {builderOpen && environmentId !== undefined ? (
        <HookBuilder
          environmentId={environmentId}
          projectId={projectId}
          scope={panelScope}
          onSaved={onChanged}
        />
      ) : null}
      {showIntro ? (
        <SettingsRow
          title="Codex staged-write safeguard"
          description="T3 verifies staged changes against original file hashes. Only you can approve exact hook scripts; each event shows its coverage limits."
        />
      ) : null}
      {query.error !== null ? (
        <SettingsRow
          title="Could not load hooks"
          description={query.error}
          control={
            <Button variant="outline" size="sm" onClick={query.refresh}>
              Retry
            </Button>
          }
          role="alert"
        />
      ) : query.isPending ? (
        <SettingsRow
          title="Loading hooks"
          description="Reading this project's hook registry."
          role="status"
        />
      ) : hooks.length === 0 ? (
        <SettingsRow
          title={search.trim() ? "No matching hooks" : "No hooks yet"}
          description={
            search.trim()
              ? "Try another name, event, status, or script hash."
              : panelScope === "all-projects"
                ? "No hooks for all projects in this environment yet."
                : "No hooks specific to this project yet. All-project hooks appear above."
          }
          role="status"
        />
      ) : (
        <div className="divide-y divide-border/50 rounded-xl border border-border/60">
          {hooks.map((hook) => (
            <article key={hook.id} className="space-y-3 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <h3 className="font-medium">{hook.name}</h3>
                  <p className="text-sm text-muted-foreground">
                    {EVENT_LABELS[hook.event]} ·{" "}
                    {hook.scope === "all-projects" ? "All projects" : "This project"} ·{" "}
                    {hook.status === "draft"
                      ? "Needs review"
                      : hook.enabled
                        ? "Active"
                        : "Disabled"}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {hookSummary(hook) ??
                      "No description provided. Review the script for its behavior."}
                  </p>
                </div>
                {hook.status === "draft" ? (
                  <Button
                    size="sm"
                    disabled={busyId !== null || editingId === hook.id}
                    onClick={() => void act(hook, "approve")}
                  >
                    {busyId === hook.id ? "Approving…" : "Review and approve"}
                  </Button>
                ) : (
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-sm text-muted-foreground">
                      {hook.enabled ? "Enabled" : "Disabled"}
                    </span>
                    <Switch
                      checked={hook.enabled}
                      disabled={busyId !== null}
                      onCheckedChange={() => void act(hook, "toggle")}
                      aria-label={`${hook.enabled ? "Disable" : "Enable"} ${hook.name}`}
                    />
                  </div>
                )}
              </div>
              <p className="break-all text-xs text-muted-foreground">
                SHA-256 · {hook.scriptSha256}
              </p>
              <HookRemoveControl
                hook={hook}
                supported={removalSupported}
                disabled={
                  busyId !== null ||
                  environmentId === undefined ||
                  !readEnvironmentScope(environmentId, AuthSettingsWriteScope)
                }
                onRemove={() => void remove(hook)}
              />
              {hook.status === "draft" ? (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm text-muted-foreground">
                    Review the script and hash. Approval applies only to this exact version.
                  </p>
                  {editingId === hook.id ? (
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busyId !== null}
                        onClick={() => setEditingId(null)}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        disabled={busyId !== null || draftScript === hook.script}
                        onClick={() => void saveDraft(hook)}
                      >
                        {busyId === hook.id ? "Saving…" : "Save draft"}
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busyId !== null}
                      onClick={() => {
                        setDraftScript(hook.script);
                        setEditingId(hook.id);
                      }}
                    >
                      Edit draft
                    </Button>
                  )}
                </div>
              ) : null}
              {editingId === hook.id ? (
                <Textarea
                  aria-label={`Edit ${hook.name} script`}
                  value={draftScript}
                  onChange={(event) => setDraftScript(event.target.value)}
                  className="min-h-56"
                />
              ) : (
                <details open={hook.status === "draft" ? true : undefined}>
                  <summary className="cursor-pointer text-sm text-muted-foreground">
                    View script
                  </summary>
                  <pre className="mt-2 max-h-72 overflow-auto rounded-md border border-border/60 bg-muted/30 p-3 font-mono text-xs leading-relaxed">
                    <code>{hook.script}</code>
                  </pre>
                </details>
              )}
            </article>
          ))}
        </div>
      )}
    </SettingsSection>
  );
}
