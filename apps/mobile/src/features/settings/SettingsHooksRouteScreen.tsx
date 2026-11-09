import { Button } from "../../components/ui/Button";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  HookEvent,
  type EnvironmentId,
  type HookDefinition,
  type ProjectId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef, useState } from "react";
import { hookSummary } from "@t3tools/shared/hookSummary";
import { Alert, AppState, Pressable, Switch, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironments } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import {
  hooksList,
  hookApprove,
  hookSetEnabled,
  hookUpdateDraft,
  hookDelete,
} from "../../state/hooks";
import { useServerConfigs } from "../../state/entities";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import { hooksForSection, sharedHookTargets, visibleHookTargets } from "./hooks-overview.logic";

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

export function SettingsHooksRouteScreen() {
  const environmentMenu = useSettingsEnvironmentMenu();
  const { environments } = useEnvironments();
  const { availableTargets, selectedTargets, selectedIds, projectGroups, selectedProjectKey } =
    useSettingsEnvironmentFilter({ includeDisconnected: true });
  const insets = useSafeAreaInsets();
  const environmentIds = new Set(selectedTargets.map((target) => target.environmentId));
  const groups = projectGroups.filter(
    (group) => selectedProjectKey === null || group.key === selectedProjectKey,
  );
  const projects = groups.flatMap((group) =>
    group.members
      .filter((member) => environmentIds.has(member.project.environmentId))
      .map((member) => ({ project: member.project, groupLabel: group.label })),
  );
  const visibleProjects = visibleHookTargets(projects, selectedProjectKey !== null);
  const sharedProjects = sharedHookTargets([...visibleProjects, ...projects]);
  const selectionKey = `${selectedProjectKey ?? "*"}:${selectedIds ? [...selectedIds].sort().join(",") : "*"}`;
  const [lastView, setLastView] = useState<{
    signature: string;
    selectionKey: string;
    targets: typeof selectedTargets;
    visible: typeof visibleProjects;
    shared: typeof sharedProjects;
  } | null>(null);
  const viewSignature = JSON.stringify([
    selectionKey,
    selectedTargets.map((target) => [target.environmentId, target.label]),
    projects.map(({ project, groupLabel }) => [
      project.id,
      project.environmentId,
      project.title,
      project.archivedAt,
      groupLabel,
    ]),
  ]);
  if (projects.length > 0 && lastView?.signature !== viewSignature) {
    setLastView({
      signature: viewSignature,
      selectionKey,
      targets: selectedTargets,
      visible: visibleProjects,
      shared: sharedProjects,
    });
  }
  if (
    projects.length === 0 &&
    lastView &&
    lastView.targets.some(
      (target) =>
        !environments.some((environment) => environment.environmentId === target.environmentId),
    )
  ) {
    setLastView(null);
  }
  const offlineView =
    availableTargets.length === 0 &&
    lastView?.selectionKey === selectionKey &&
    lastView.targets.every((target) =>
      environments.some((environment) => environment.environmentId === target.environmentId),
    )
      ? lastView
      : null;
  const targetsToShow = offlineView?.targets ?? selectedTargets;
  const visibleToShow = offlineView?.visible ?? visibleProjects;
  const sharedToShow = offlineView?.shared ?? sharedProjects;
  const hasOfflineTargets = targetsToShow.some((target) => target.connection.phase !== "connected");

  return (
    <>
      <SettingsScreen title="Hooks and safeguards" menus={[environmentMenu]}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-5 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {offlineView || hasOfflineTargets ? (
            <Text className="text-foreground-muted">
              Disconnected. Showing last known hooks; they may be out of date. Reconnect to make
              changes.
            </Text>
          ) : null}
          {projects.length === 0 && !offlineView ? (
            <Text className="text-foreground-muted">
              {availableTargets.length === 0
                ? "Connect an environment with a project to manage hooks."
                : "Select a project with a connected environment to manage its hooks."}
            </Text>
          ) : (
            <>
              {sharedToShow.map(({ project }) => {
                const environment = targetsToShow.find(
                  (target) => target.environmentId === project.environmentId,
                );
                if (!environment) return null;
                return (
                  <HookProjectSection
                    key={`shared:${environment.environmentId}`}
                    environmentId={environment.environmentId}
                    environmentLabel={environment.label}
                    projectId={project.id as ProjectId}
                    projectLabel="All projects"
                    hookScope="all-projects"
                    offline={offlineView !== null || environment.connection.phase !== "connected"}
                  />
                );
              })}
              {visibleToShow.map(({ project, groupLabel }) => {
                const environment = targetsToShow.find(
                  (target) => target.environmentId === project.environmentId,
                );
                if (!environment) return null;
                return (
                  <HookProjectSection
                    key={`${environment.environmentId}:${project.id}`}
                    environmentId={environment.environmentId}
                    environmentLabel={environment.label}
                    projectId={project.id as ProjectId}
                    projectLabel={`${project.title || groupLabel}${project.archivedAt == null ? "" : " (archived)"}`}
                    hookScope="project"
                    offline={offlineView !== null || environment.connection.phase !== "connected"}
                  />
                );
              })}
            </>
          )}
        </ScrollView>
      </SettingsScreen>
    </>
  );
}

function HookProjectSection(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly projectId: ProjectId;
  readonly projectLabel: string;
  readonly hookScope: "all-projects" | "project";
  readonly offline: boolean;
}) {
  const query = useEnvironmentQuery(
    hooksList({
      environmentId: props.environmentId,
      input: { projectId: props.projectId, supportedEvents: HookEvent.literals },
    }),
  );
  const { refresh } = query;
  const [lastHooks, setLastHooks] = useState<readonly HookDefinition[] | null>(null);
  if (!props.offline && query.data !== null && query.data !== lastHooks) {
    setLastHooks(query.data);
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hook state may change on another client while the app is backgrounded
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => subscription.remove();
  }, [refresh]);
  const offlineHooks = lastHooks ?? query.data;
  const hooks = hooksForSection((props.offline ? offlineHooks : query.data) ?? [], props.hookScope);
  return (
    <SettingsSection title={`${props.projectLabel}  /  ${props.environmentLabel}`}>
      {props.offline ? (
        <View className="gap-3 px-4 py-3">
          {offlineHooks === null ? (
            <Text>No cached hooks for this section.</Text>
          ) : hooks.length === 0 ? (
            <Text>No hooks in the last successful view.</Text>
          ) : (
            hooks.map((hook) => (
              <View key={hook.id} className="gap-1">
                <Text className="font-t3-medium">{hook.name}</Text>
                <Text>
                  {EVENT_LABELS[hook.event]} /{" "}
                  {hook.status === "draft" ? "Draft" : hook.enabled ? "Enabled" : "Disabled"}
                </Text>
                <Text>{hook.script}</Text>
              </View>
            ))
          )}
        </View>
      ) : (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Refresh hooks for ${props.projectLabel}`}
            onPress={refresh}
            className="self-end px-4 py-3"
          >
            <Text className="text-foreground">Refresh hooks</Text>
          </Pressable>
          {props.hookScope === "all-projects" ? (
            <View className="gap-1 border-b border-border/50 px-4 py-3">
              <Text className="font-t3-medium text-foreground">Codex staged-write safeguard</Text>
              <Text className="text-sm text-foreground-muted">
                When staged changes are installed, T3 checks the manifest and original file hashes.
                Codex uses the permission mode selected for the chat.
              </Text>
              <Text className="pt-1 text-sm text-foreground-muted">
                Agents can draft hooks for all projects in this environment or for one project. You
                must review and approve each exact script and its hash before it can run. A
                provider-start script can require a T3-managed worktree by returning{" "}
                <Text className="font-t3-medium text-foreground">
                  {'{ decision: "allow", enforcement: "managed-worktree" }'}
                </Text>
                . Turn-end scripts can block staged installation or request continuation.
              </Text>
              <Text className="pt-1 text-sm text-foreground-muted">
                Hooks cover supported T3 actions. They do not intercept native file writes, external
                Git, Notion, browser actions outside T3, or system process checks.
              </Text>
            </View>
          ) : null}
          {query.error ? (
            <Text className="p-4 text-danger">{query.error}</Text>
          ) : query.isPending ? (
            <Text className="p-4 text-foreground-muted">Loading hooks...</Text>
          ) : hooks.length === 0 ? (
            <Text className="p-4 text-foreground-muted">
              {props.hookScope === "all-projects"
                ? "No shared hooks yet. Agents can propose scripts; they stay inactive until you approve them."
                : "No project-specific hooks."}
            </Text>
          ) : (
            <View className="gap-3">
              {hooks.map((hook) => (
                <HookCard
                  key={`${hook.id}:${hook.scriptSha256}`}
                  environmentId={props.environmentId}
                  projectId={props.projectId}
                  hook={hook}
                  refresh={query.refresh}
                />
              ))}
            </View>
          )}
        </>
      )}
    </SettingsSection>
  );
}

function HookCard(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly hook: HookDefinition;
  readonly refresh: () => void;
}) {
  const { hook } = props;
  const mounted = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- native confirmation can outlive the card after disconnection
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const approve = useAtomCommand(hookApprove, {
    label: "approve hook draft",
    reportFailure: false,
  });
  const updateDraft = useAtomCommand(hookUpdateDraft, {
    label: "edit hook draft",
    reportFailure: false,
  });
  const setEnabled = useAtomCommand(hookSetEnabled, {
    label: "change hook status",
    reportFailure: false,
  });
  const removeHook = useAtomCommand(hookDelete, {
    label: "remove disabled hook",
    reportFailure: false,
  });
  const removalSupported =
    useServerConfigs().get(props.environmentId)?.environment.capabilities.hookRemoval === true;
  const [editing, setEditing] = useState(false);
  const [scriptExpanded, setScriptExpanded] = useState(false);
  const [script, setScript] = useState(hook.script);
  const [pending, setPending] = useState(false);
  const hasScope = useEnvironmentScope(props.environmentId, AuthSettingsWriteScope);
  const canApprove = useAtomValue(hookApprove.permissionAtom(props.environmentId)) && hasScope;
  const canEdit = useAtomValue(hookUpdateDraft.permissionAtom(props.environmentId)) && hasScope;
  const canToggle = useAtomValue(hookSetEnabled.permissionAtom(props.environmentId)) && hasScope;
  const canRemove =
    useAtomValue(hookDelete.permissionAtom(props.environmentId)) && hasScope && removalSupported;

  const showFailure = (title: string, result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      Alert.alert(title, String(squashAtomCommandFailure(result)));
    }
  };

  const save = async () => {
    if (
      !canEdit ||
      !readEnvironmentScope(props.environmentId, AuthSettingsWriteScope) ||
      pending ||
      script === hook.script
    )
      return;
    setPending(true);
    const result = await updateDraft({
      environmentId: props.environmentId,
      input: { projectId: props.projectId, hookId: hook.id, script },
    });
    setPending(false);
    showFailure("Could not save draft", result);
    if (result._tag === "Success") {
      setEditing(false);
      props.refresh();
    }
  };

  const reviewAndApprove = () => {
    if (
      !canApprove ||
      !readEnvironmentScope(props.environmentId, AuthSettingsWriteScope) ||
      pending ||
      editing ||
      !scriptExpanded
    )
      return;
    Alert.alert(
      "Approve this exact script?",
      `Event: ${EVENT_LABELS[hook.event]}\nScope: ${hook.scope === "all-projects" ? "all projects in this environment" : "this project"}\nSHA-256: ${hook.scriptSha256}\n\nReview the full script above. Approval activates and enables this exact version.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Approve",
          onPress: () => {
            if (
              !mounted.current ||
              !readEnvironmentScope(props.environmentId, AuthSettingsWriteScope)
            ) {
              Alert.alert(
                "Could not approve hook",
                "This connection no longer grants settings write access.",
              );
              return;
            }
            setPending(true);
            void approve({
              environmentId: props.environmentId,
              input: {
                projectId: props.projectId,
                hookId: hook.id,
                reviewedSha256: hook.scriptSha256,
                reviewedEvent: hook.event,
                reviewedScope: hook.scope ?? "project",
              },
            }).then((result) => {
              setPending(false);
              showFailure("Could not approve hook", result);
              if (result._tag === "Success") props.refresh();
            });
          },
        },
      ],
    );
  };

  const remove = () => {
    if (
      !canRemove ||
      hook.enabled ||
      pending ||
      !readEnvironmentScope(props.environmentId, AuthSettingsWriteScope)
    )
      return;
    Alert.alert(
      "Remove disabled hook?",
      `Remove "${hook.name}"? A recovery copy of this exact version will be kept.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            if (
              !mounted.current ||
              !readEnvironmentScope(props.environmentId, AuthSettingsWriteScope)
            )
              return;
            setPending(true);
            void removeHook({
              environmentId: props.environmentId,
              input: {
                projectId: props.projectId,
                hookId: hook.id,
                expectedSha256: hook.scriptSha256,
              },
            }).then((result) => {
              setPending(false);
              showFailure("Could not remove hook", result);
              if (result._tag === "Success") props.refresh();
            });
          },
        },
      ],
    );
  };

  const toggle = async (enabled: boolean) => {
    if (!canToggle || !readEnvironmentScope(props.environmentId, AuthSettingsWriteScope) || pending)
      return;
    setPending(true);
    const result = await setEnabled({
      environmentId: props.environmentId,
      input: { projectId: props.projectId, hookId: hook.id, enabled },
    });
    setPending(false);
    showFailure("Could not update hook", result);
    if (result._tag === "Success") props.refresh();
  };

  return (
    <View className="gap-3 rounded-2xl border border-border/60 p-4">
      <View className="flex-row items-start justify-between gap-3">
        <View className="min-w-0 flex-1 gap-1">
          <Text className="font-t3-medium text-foreground">{hook.name}</Text>
          <Text className="text-sm text-foreground-muted">
            {EVENT_LABELS[hook.event]} /{" "}
            {hook.scope === "all-projects" ? "All projects" : "This project"} /{" "}
            {hook.status === "draft" ? "Needs review" : hook.enabled ? "Active" : "Disabled"}
          </Text>
          <Text className="text-sm text-foreground-muted">
            {hookSummary(hook) ?? "No description provided. Review the script for its behavior."}
          </Text>
        </View>
        {hook.status === "active" ? (
          <Switch
            value={hook.enabled}
            disabled={!canToggle || pending}
            onValueChange={(value) => void toggle(value)}
            accessibilityLabel={`${hook.enabled ? "Disable" : "Enable"} ${hook.name}`}
          />
        ) : null}
      </View>
      <Text selectable className="text-xs text-foreground-muted">
        SHA-256 / {hook.scriptSha256}
      </Text>
      <Button
        label={scriptExpanded ? "Hide script" : "Show script"}
        accessibilityLabel={`${scriptExpanded ? "Hide" : "Show"} script for ${hook.name}`}
        tone="secondary"
        size="compact"
        disabled={pending || editing}
        onPress={() => setScriptExpanded((expanded) => !expanded)}
      />
      {scriptExpanded || editing ? (
        <TextInput
          accessibilityLabel={`${hook.name} script`}
          editable={hook.status === "draft" && editing && canEdit && !pending}
          multiline
          scrollEnabled
          selectTextOnFocus={false}
          value={editing ? script : hook.script}
          onChangeText={setScript}
          textAlignVertical="top"
          style={{ height: 240 }}
          className="rounded-xl bg-subtle p-3 font-mono text-xs text-foreground"
        />
      ) : null}
      {hook.status === "draft" ? (
        <View className="flex-row flex-wrap gap-3">
          {editing ? (
            <>
              <Button
                label="Cancel"
                disabled={pending}
                onPress={() => {
                  setScript(hook.script);
                  setEditing(false);
                }}
              />
              <Button
                label={pending ? "Saving..." : "Save draft"}
                tone="contrast"
                disabled={!canEdit || pending || script === hook.script}
                onPress={() => void save()}
              />
            </>
          ) : (
            <>
              <Button
                label="Edit draft"
                disabled={!canEdit || pending}
                onPress={() => {
                  setScriptExpanded(true);
                  setEditing(true);
                }}
              />
              {scriptExpanded ? (
                <Button
                  label={pending ? "Approving..." : "Review and approve"}
                  accessibilityLabel={`Review and approve ${hook.name}`}
                  tone="contrast"
                  disabled={!canApprove || pending}
                  onPress={reviewAndApprove}
                />
              ) : null}
            </>
          )}
        </View>
      ) : null}
      {!hook.enabled && removalSupported ? (
        <Button
          label="Remove"
          accessibilityLabel={`Remove ${hook.name}`}
          tone="danger"
          disabled={!canRemove || pending}
          onPress={remove}
        />
      ) : null}
      {!hasScope ? (
        <Text className="text-xs text-foreground-muted">
          This connection does not grant settings write access.
        </Text>
      ) : null}
      {hook.status === "draft" && hasScope && !canApprove ? (
        <Text className="text-xs text-foreground-muted">
          Approval is unavailable until this connection permits hook changes.
        </Text>
      ) : null}
    </View>
  );
}
