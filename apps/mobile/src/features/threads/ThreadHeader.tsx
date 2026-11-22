import { AppBar } from "../../components/ui/AppBar";
import type { AppBarAction, AppBarMenu, AppBarMenuItem } from "../../components/ui/AppBar.types";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import type { ThreadInspectorMode } from "./thread-inspector-navigation";
import { useWorkspaceBackNavigation } from "../layout/workspace/useAndroidWorkspaceNavigation";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { useState } from "react";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText } from "../../components/ui/AppText";
import { useThreadGitMenuDefinition, type ThreadGitControlsProps } from "./ThreadGitControls";
import { formatContextUsage, mobileThreadSurfaces } from "./threadHeader.logic";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useSideChats } from "../../state/entities";
import { useOpenLinkedThread } from "./useOpenLinkedThread";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";

export function ThreadHeader(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly environmentLabel?: string | null;
  readonly gitControls: ThreadGitControlsProps;
  readonly onReturnToThread?: () => void;
  readonly draft?: boolean;
  readonly hasThreadCwd: boolean;
  readonly inspectorMode: ThreadInspectorMode | null;
  readonly onOpenFilesInspector: () => void;
  readonly onOpenGitInspector: () => void;
  readonly contextUsage?: { readonly usedTokens: number; readonly maxTokens: number | null } | null;
  readonly contextPercentage?: number | null;
  readonly previousAgentCount?: number;
  readonly onOpenLineage?: () => void;
}) {
  const goBack = useWorkspaceBackNavigation();
  const { startNewTask } = useAdaptiveWorkspaceLayout();
  const [sheet, setSheet] = useState<"details" | "surfaces" | null>(null);
  const threadRef = {
    environmentId: EnvironmentId.make(String(props.gitControls.environmentId)),
    threadId: ThreadId.make(String(props.gitControls.threadId)),
  };
  const sideChats = useSideChats(threadRef);
  const openLinkedThread = useOpenLinkedThread();
  // Reuse the git menu so publish/review keep their scope checks and default-branch confirmation.
  const gitItems = useThreadGitMenuDefinition(props.gitControls)?.items ?? [];
  const gitItem = (id: string) =>
    gitItems.find(
      (item): item is Extract<AppBarMenuItem, { onPress: () => void }> =>
        item.id === id && "onPress" in item,
    );
  const quickAction = gitItem("git-quick-action");
  const reviewItem = gitItem("git-review");
  const mergeBackItem = gitItem("git-merge-back");
  const runGitItem = (item: ReturnType<typeof gitItem>) =>
    item && !item.disabled
      ? () => {
          dismiss();
          item.onPress();
        }
      : undefined;
  // Reopen the thread's terminal (the terminal screen can start another one) instead of
  // spawning a new shell on every tap; this also works for read-only terminal access.
  const openTerminal = () =>
    props.gitControls.onOpenTerminal(props.gitControls.terminalSessions[0]?.terminalId ?? null);
  const actions: AppBarAction[] = [
    {
      accessibilityLabel: "Thread details",
      icon: "list.number",
      onPress: () => setSheet("details"),
    },
    {
      accessibilityLabel: "Open terminal",
      icon: "terminal",
      disabled: !props.gitControls.canOpenTerminal,
      onPress: openTerminal,
    },
    {
      accessibilityLabel: "Open a surface",
      icon: "square.split.2x1",
      onPress: () => setSheet("surfaces"),
    },
  ];
  const menus: AppBarMenu[] = [];
  const dismiss = () => setSheet(null);
  const openFiles = () => {
    dismiss();
    props.onOpenFilesInspector();
  };
  const openGit = () => {
    dismiss();
    props.onOpenGitInspector();
  };
  const surfaceRow = (label: string, icon: string, onPress?: () => void, reason?: string) => (
    <Pressable
      key={label}
      disabled={!onPress}
      onPress={onPress}
      className={`flex-row items-center gap-3 rounded-xl px-4 py-3 ${onPress ? "active:bg-card-alt" : "opacity-40"}`}
      accessibilityRole="button"
      accessibilityState={{ disabled: !onPress }}
    >
      <SymbolView name={icon as never} size={19} tintColorClassName="accent-icon-muted" />
      <View className="flex-1">
        <AppText className="text-sm text-foreground">{label}</AppText>
        {reason ? <AppText className="text-xs text-foreground-muted">{reason}</AppText> : null}
      </View>
    </Pressable>
  );
  const surfaceAvailability = mobileThreadSurfaces({
    canOpenTerminal: props.gitControls.canOpenTerminal,
    canOpenFiles: props.gitControls.canOpenFiles,
    isGitRepo: props.gitControls.gitStatus?.isRepo ?? false,
    hasPullRequest: Boolean(props.gitControls.gitStatus?.pr),
    hasSideChat: sideChats.length > 0,
  });
  const surfaceIcons = {
    browser: "globe",
    terminal: "terminal",
    files: "folder",
    diff: "arrow.left.arrow.right",
    "pull-request": "arrow.up.right",
    "linked-pull-requests": "link",
    device: "iphone",
    "side-chat": "bubble.left.and.bubble.right",
  } as const;
  const surfaceHandlers = {
    terminal: () => {
      dismiss();
      openTerminal();
    },
    files: openFiles,
    diff: runGitItem(reviewItem) ?? openGit,
    "pull-request": openGit,
    "side-chat": () => {
      const sideChat = sideChats[0];
      if (!sideChat) return;
      dismiss();
      openLinkedThread({
        environmentId: String(props.gitControls.environmentId),
        threadId: String(sideChat.id),
      });
    },
  };

  return (
    <>
      <AppBar
        title={props.title}
        subtitle={props.subtitle}
        onBackToList={goBack}
        onCompose={props.draft ? undefined : startNewTask}
        backInSplitView={
          props.onReturnToThread
            ? {
                accessibilityLabel: "Return to chat",
                icon: "chevron.left",
                onPress: props.onReturnToThread,
              }
            : undefined
        }
        actions={actions}
        menus={menus}
        hideBottomBorder
      />
      <Modal
        visible={sheet !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={dismiss}
      >
        <View className="flex-1 bg-screen pt-5">
          <View className="flex-row items-center justify-between border-b border-border px-5 pb-4">
            <AppText className="text-lg font-semibold text-foreground">
              {sheet === "details" ? "Thread details" : "Open a surface"}
            </AppText>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={dismiss}
              className="p-2"
            >
              <SymbolView name="xmark" size={18} tintColorClassName="accent-icon-muted" />
            </Pressable>
          </View>
          <ScrollView contentContainerClassName="gap-1 p-3">
            {sheet === "details" ? (
              <>
                {surfaceRow(
                  props.environmentLabel ?? "Environment",
                  "desktopcomputer",
                  props.gitControls.canOpenFiles ? openFiles : undefined,
                  "Open folder and files",
                )}
                {props.gitControls.projectScripts.map((script) =>
                  surfaceRow(
                    script.name,
                    "play",
                    () => {
                      dismiss();
                      void props.gitControls.onRunProjectScript(script);
                    },
                    script.command,
                  ),
                )}
                {surfaceRow(
                  "Add project script",
                  "plus",
                  undefined,
                  "Script editing is not available on mobile yet",
                )}
                {surfaceRow(
                  `Branch · ${props.gitControls.gitStatus?.refName ?? props.gitControls.currentBranch ?? "Detached HEAD"}`,
                  "arrow.triangle.branch",
                  openGit,
                )}
                {surfaceRow(
                  quickAction?.title ?? "Publish repository",
                  "arrow.up",
                  runGitItem(quickAction),
                  quickAction?.subtitle ?? "Commit, push or open a pull request",
                )}
                {surfaceRow(
                  `Changes · +${props.gitControls.gitStatus?.workingTree?.insertions ?? 0} / −${props.gitControls.gitStatus?.workingTree?.deletions ?? 0}`,
                  "arrow.left.arrow.right",
                  runGitItem(reviewItem),
                  reviewItem?.subtitle,
                )}
                {mergeBackItem
                  ? surfaceRow(
                      mergeBackItem.title,
                      PullRequestGlyph.merged,
                      runGitItem(mergeBackItem),
                      mergeBackItem.subtitle,
                    )
                  : null}
                {surfaceRow(
                  `Previous agents · ${props.previousAgentCount ?? 0}`,
                  "person.2",
                  props.onOpenLineage,
                  "Lineage",
                )}
                <View className="flex-row items-center gap-3 rounded-xl px-4 py-3">
                  <SymbolView
                    name="chart.bar.xaxis"
                    size={19}
                    tintColorClassName="accent-icon-muted"
                  />
                  <View className="flex-1 gap-2">
                    <View className="flex-row justify-between">
                      <AppText className="text-sm text-foreground">Context</AppText>
                      <AppText className="text-xs text-foreground-muted">
                        {props.contextUsage
                          ? formatContextUsage(
                              props.contextUsage.usedTokens,
                              props.contextUsage.maxTokens,
                            )
                          : "No context usage reported"}
                      </AppText>
                    </View>
                    <View className="h-1.5 overflow-hidden rounded-full bg-subtle">
                      <View
                        className="h-full rounded-full bg-accent"
                        style={{
                          width: `${Math.max(0, Math.min(100, props.contextPercentage ?? 0))}%`,
                        }}
                      />
                    </View>
                  </View>
                </View>
              </>
            ) : (
              <>
                {surfaceAvailability.map((item) =>
                  surfaceRow(
                    item.label,
                    surfaceIcons[item.id],
                    item.available
                      ? surfaceHandlers[item.id as keyof typeof surfaceHandlers]
                      : undefined,
                    item.available ? undefined : item.reason,
                  ),
                )}
              </>
            )}
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}
