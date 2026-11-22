import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ThreadId,
  type EnvironmentId,
  type MessageId,
} from "@t3tools/contracts";
import { threadContextsOutsideEnvironment } from "@t3tools/shared/composerContextReferences";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";
import { Dimensions, Platform, Pressable, View, type ViewInstance } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSharedValue } from "react-native-reanimated";

import type { ComposerEditorHandle } from "../../components/ComposerEditor";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { makeTurnCommandMetadata } from "../../lib/commandMetadata";
import { composerContextSendBlockReason } from "../../lib/composerContext";
import {
  describeUnavailableModelSelection,
  isModelSelectionUnavailable,
  resolveSelectableModelSelection,
} from "../../lib/modelOptions";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  composerAttachmentUploadBlockReason,
  composerAttachmentsStillUploading,
  composerAttachmentUploadsAtom,
} from "../../state/composer-attachment-uploads";
import { abortComposerDraftOperations } from "../../state/composerDraftOperations";
import { useEnvironmentServerConfig } from "../../state/entities";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import { useComposerAttachmentActions } from "../../state/use-composer-attachment-actions";
import {
  clearComposerDraftContent,
  composerContextImportsAtom,
  getComposerDraftSnapshot,
  scheduleUnusedComposerAttachmentCleanup,
} from "../../state/use-composer-drafts";
import { useRemoteEnvironmentRuntime } from "../../state/use-remote-environment-registry";
import { ComposerPopoverHost } from "../threads/ComposerPopoverHost";
import { draftThreadShell } from "../threads/draft-thread-shell";
import { useNewTaskFlow } from "../threads/new-task-flow-provider";
import { HOME_COMPOSER_FLOW_KEY, updateNewTaskFlowState } from "../threads/new-task-flow-state";
import { ThreadComposer } from "../threads/ThreadComposer";

/**
 * Home's bottom bar: a project picker above the thread screen's own composer. It edits a
 * new-task draft of the Home flow, so nothing is created until Send, which queues the
 * thread with this message as its first one (as the new-thread screen does) and opens it.
 */
export function HomeComposer(props: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly onThreadStarted: (thread: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  }) => void;
  /** The composer's height, so the list above can scroll clear of it. */
  readonly onHeightChange: (height: number) => void;
}) {
  const flow = useNewTaskFlow();
  const selectedProject = flow.selectedProject;
  const environmentId = selectedProject?.environmentId ?? null;
  const [creationMetadata, setCreationMetadata] = useState(makeTurnCommandMetadata);
  const editorRef = useRef<ComposerEditorHandle>(null);
  const popoverHeight = useSharedValue(0);
  const rootRef = useRef<ViewInstance>(null);
  // A send that finishes after the user left Home still clears its draft, but opens nothing.
  const mountedRef = useRef(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks whether the composer is still mounted for the async send's navigation
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // Distance from Home's bottom edge to the screen's: the tab bar sits between Home and the keyboard.
  const [keyboardOffset, setKeyboardOffset] = useState(0);
  const environmentRuntime = useRemoteEnvironmentRuntime(environmentId);
  const connectionState = environmentRuntime?.connectionState ?? "offline";
  const environmentConnected = connectionState === "connected";
  const serverConfig = useEnvironmentServerConfig(environmentId);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const contextImports = useAtomValue(composerContextImportsAtom);
  const uploadStates = useAtomValue(composerAttachmentUploadsAtom);
  const interactionLocked =
    flow.submitting || (flow.draftKey !== null && contextImports[flow.draftKey] === true);
  const attachmentActions = useComposerAttachmentActions({
    draftKey: flow.draftKey,
    serverConfig,
    locked: interactionLocked,
  });
  const environmentLabel =
    flow.environments.find(
      (environment) => environment.environmentId === flow.selectedEnvironmentId,
    )?.environmentLabel ?? "Environment";
  const pickableProjects = props.projects.filter((project) => project.archivedAt == null);

  const measureKeyboardOffset = () => {
    rootRef.current?.measureInWindow((_x, y, _width, height) => {
      const screenHeight = Dimensions.get(Platform.OS === "android" ? "screen" : "window").height;
      const offset = Math.max(0, Math.round(screenHeight - (y + height)));
      setKeyboardOffset((current) => (current === offset ? current : offset));
    });
  };

  async function sendFirstMessage(): Promise<MessageId | null> {
    const project = flow.selectedProject;
    const draftKey = flow.draftKey;
    if (!project || !draftKey || flow.submitting) return null;
    if (
      environmentConnected &&
      !readEnvironmentScope(project.environmentId, AuthOrchestrationOperateScope)
    ) {
      return null;
    }
    if (appAtomRegistry.get(composerContextImportsAtom)[draftKey]) return null;
    const draft = getComposerDraftSnapshot(draftKey);
    const modelSelection =
      resolveSelectableModelSelection(serverConfig, draft.modelSelection ?? null, project.id) ??
      flow.selectedModel;
    const workspaceSelection = flow.resolveWorkspaceSelection(draft.workspaceSelection);
    const attachmentBlockReason = composerAttachmentUploadBlockReason({
      environmentId: project.environmentId,
      attachments: draft.attachments,
      connected: environmentConnected,
      serverConfig,
      states: uploadStates,
    });
    if (
      attachmentBlockReason !== null ||
      !modelSelection ||
      (draft.text.trim().length === 0 && draft.attachments.length === 0) ||
      (workspaceSelection.mode === "worktree" && !workspaceSelection.branch)
    ) {
      return null;
    }
    if (
      environmentConnected &&
      isModelSelectionUnavailable(serverConfig, modelSelection, project.id)
    ) {
      const { title, detail } = describeUnavailableModelSelection(
        serverConfig,
        modelSelection,
        project.id,
      );
      Dialog.alert(title, detail);
      return null;
    }
    if (draft.attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      Dialog.alert(
        "Too many attachments",
        `Remove attachments until there are at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}.`,
      );
      return null;
    }
    const contextBlockReason = composerContextSendBlockReason(draft.context);
    if (contextBlockReason) {
      Dialog.alert("Too much context", contextBlockReason);
      return null;
    }
    const strandedThread = threadContextsOutsideEnvironment({
      text: draft.text,
      records: draft.context?.records ?? [],
      environmentId: project.environmentId,
      linkedEnvironments: flow.linkedEnvironments,
    })[0];
    if (strandedThread) {
      Dialog.alert(
        "Attached thread unavailable",
        `"${strandedThread.title}" is on another machine. Remove it from the message.`,
      );
      return null;
    }
    const uploading =
      environmentConnected &&
      composerAttachmentsStillUploading({
        environmentId: project.environmentId,
        attachments: draft.attachments,
        serverConfig,
        states: uploadStates,
      });
    const message = flow.buildPendingTaskMessage(creationMetadata, {
      currentCheckoutBranch:
        !environmentConnected || uploading ? null : flow.currentCheckoutBranchName,
    });
    if (!message) return null;
    // Persist locally before clearing the draft; the outbox creates the thread.
    flow.setSubmitting(true);
    const queued = await settlePromise(() => enqueueThreadOutboxMessage(message));
    flow.setSubmitting(false);
    if (AsyncResult.isFailure(queued)) {
      const error = squashAtomCommandFailure(queued);
      Dialog.alert(
        "Could not start thread",
        error instanceof Error ? error.message : "The thread could not be saved to the outbox.",
      );
      return null;
    }
    editorRef.current?.blur();
    abortComposerDraftOperations(draftKey);
    const sentDraft = getComposerDraftSnapshot(draftKey);
    clearComposerDraftContent(draftKey, {
      clearModelSelection: true,
      clearWorkspaceSelection: true,
      deferAttachmentCleanup: true,
    });
    scheduleUnusedComposerAttachmentCleanup(sentDraft.attachments);
    // The next message on Home starts a fresh draft and thread.
    updateNewTaskFlowState(HOME_COMPOSER_FLOW_KEY, { draftKey: null });
    setCreationMetadata(makeTurnCommandMetadata());
    if (mountedRef.current) {
      props.onThreadStarted({ environmentId: message.environmentId, threadId: message.threadId });
    }
    return message.messageId;
  }

  const projectPicker = (
    <Menu
      actions={pickableProjects.map((project) => ({
        id: scopedProjectKey(project.environmentId, project.id),
        title: project.title,
        state:
          selectedProject?.environmentId === project.environmentId &&
          selectedProject.id === project.id
            ? ("on" as const)
            : ("off" as const),
      }))}
      onPressAction={({ nativeEvent }) => {
        const project = pickableProjects.find(
          (candidate) =>
            scopedProjectKey(candidate.environmentId, candidate.id) === nativeEvent.event,
        );
        if (project && !interactionLocked) flow.setProject(project);
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Project: ${selectedProject?.title ?? "none"}`}
        accessibilityHint="Chooses the project the new thread starts in"
        className="flex-row items-center gap-1.5 self-start rounded-full px-2 py-1.5 active:opacity-65"
      >
        {selectedProject ? (
          <ProjectFavicon
            environmentId={selectedProject.environmentId}
            projectTitle={selectedProject.title}
            workspaceRoot={selectedProject.workspaceRoot}
            faviconPath={selectedProject.faviconPath}
            projectIcon={selectedProject.projectIcon}
            size={18}
          />
        ) : (
          <SymbolView
            name="folder"
            size={13}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
          />
        )}
        <Text className="text-xs font-t3-medium text-foreground" numberOfLines={1}>
          {selectedProject?.title ?? "Choose project"}
        </Text>
        <SymbolView
          name="chevron.down"
          size={11}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
      </Pressable>
    </Menu>
  );

  const thread =
    selectedProject && flow.selectedModel
      ? draftThreadShell({
          environmentId: selectedProject.environmentId,
          projectId: selectedProject.id,
          threadId: ThreadId.make(creationMetadata.threadId),
          modelSelection: flow.selectedModel,
          runtimeMode: flow.runtimeMode,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: flow.selectedBranchName,
          worktreePath: flow.selectedWorktreePath,
          createdAt: creationMetadata.createdAt,
        })
      : null;

  return (
    <View
      ref={rootRef}
      collapsable={false}
      pointerEvents="box-none"
      className="absolute inset-0"
      onLayout={measureKeyboardOffset}
    >
      <KeyboardStickyView
        pointerEvents="box-none"
        style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0 }}
        offset={{ closed: 0, opened: keyboardOffset }}
      >
        <ComposerPopoverHost hidden={false} popoverHeight={popoverHeight}>
          <View
            className="absolute inset-x-0 bottom-0"
            onLayout={(event) => props.onHeightChange(event.nativeEvent.layout.height)}
          >
            <View className="px-3 pt-1">{projectPicker}</View>
            {thread && selectedProject && flow.draftKey ? (
              <ThreadComposer
                isDraft
                canOperateThread={canOperate}
                editorRef={editorRef}
                placeholder="Ask anything"
                connectionState={connectionState}
                environmentLabel={environmentLabel}
                selectedThread={thread}
                hasCompactableConversation={false}
                offersSideChat={false}
                serverConfig={serverConfig}
                queueCount={0}
                activeThreadBusy={false}
                redirectsApproval={false}
                canStopThread={false}
                environmentId={selectedProject.environmentId}
                projectCwd={flow.workspaceCwd}
                sendBlockedReason={
                  flow.submitting
                    ? "Starting the thread…"
                    : flow.workspaceMode === "worktree" &&
                        (!flow.selectedBranchName || !flow.isGitRepoKnown)
                      ? "Choose a base branch before creating a worktree."
                      : null
                }
                interactionLocked={interactionLocked}
                draftKey={flow.draftKey}
                followUpBehavior="queue"
                canSteerActiveTurn={false}
                hidden={false}
                onChangeDraftMessage={flow.setPrompt}
                onPickDraftMedia={attachmentActions.onPickDraftMedia}
                onPickDraftFiles={attachmentActions.onPickDraftFiles}
                onNativePasteImages={attachmentActions.onNativePasteImages}
                onNativePasteText={attachmentActions.onNativePasteText}
                onRemoveDraftImage={flow.removeAttachment}
                onStopThread={() => {}}
                onResumeQueue={null}
                onSendMessage={sendFirstMessage}
                onShowUsageLimits={() => {}}
                canSwitchProvider
              />
            ) : (
              <Text className="px-4 pb-3 pt-1 text-xs text-foreground-muted">
                {selectedProject
                  ? `Connect to ${environmentLabel} to start a thread.`
                  : "Add a project to start a thread."}
              </Text>
            )}
          </View>
        </ComposerPopoverHost>
      </KeyboardStickyView>
    </View>
  );
}
