import { AppBar } from "../../components/ui/AppBar";
import type { AppBarAction, AppBarMenu, AppBarMenuItem } from "../../components/ui/AppBar.types";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import type { ThreadInspectorMode } from "./thread-inspector-navigation";
import { useWorkspaceBackNavigation } from "../layout/workspace/useAndroidWorkspaceNavigation";
import { Modal, Platform, Pressable, ScrollView, View } from "react-native";
import { useEffect, useState, type ReactNode } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText } from "../../components/ui/AppText";
import { useThreadGitMenuDefinition, type ThreadGitControlsProps } from "./ThreadGitControls";
import {
  deferUntilModalDismiss,
  formatContextUsage,
  mobileThreadSurfaces,
  runAfterModalDismiss,
} from "./threadHeader.logic";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useSideChats } from "../../state/entities";
import { useOpenLinkedThread } from "./useOpenLinkedThread";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import {
  isMobileAgentTab,
  isMobileSideChatTab,
  isMobileSurfaceTab,
  mobileAgentTabTarget,
  mobileSidePanelThreadLabel,
  mobileSidePanelStore,
  useMobileSidePanelTabs,
} from "./mobileSidePanelStore";
import type { MobileSidePanelTabId, MobileSurfaceTabId } from "./mobileSidePanelStore";
import { InlineSidePanelNavigator } from "./InlineSidePanelNavigator";

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
  readonly canOpenBrowser?: boolean;
  readonly onOpenBrowserPreview?: () => void;
  readonly onStartNewSideChat?: () => Promise<MobileSidePanelTabId | null>;
  readonly renderSidePanelSurface?: (tab: MobileSidePanelTabId, sideChatId?: string) => ReactNode;
}) {
  const goBack = useWorkspaceBackNavigation();
  const { startNewTask } = useAdaptiveWorkspaceLayout();
  const insets = useSafeAreaInsets();
  const isAndroid = Platform.OS === "android";
  const [sheet, setSheet] = useState<"details" | "surfaces" | "surface-list" | null>(null);
  const [skipDismissAnimation, setSkipDismissAnimation] = useState(false);
  const [pendingDismissedAction, setPendingDismissedAction] = useState<(() => void) | null>(null);
  const threadRef = {
    environmentId: EnvironmentId.make(String(props.gitControls.environmentId)),
    threadId: ThreadId.make(String(props.gitControls.threadId)),
  };
  const sideChats = useSideChats(threadRef);
  const surfaceKey = `${String(threadRef.environmentId)}:${String(threadRef.threadId)}`;
  const surfaceTabs = useMobileSidePanelTabs(surfaceKey);
  const openLinkedThread = useOpenLinkedThread();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drops side-chat tabs from the external tab store when their parent no longer lists those chats
  useEffect(() => {
    const currentTabs = mobileSidePanelStore.getSnapshot(surfaceKey).tabs;
    const available = new Set(
      currentTabs.filter(
        (tab) =>
          !isMobileSideChatTab(tab) || sideChats.some((chat) => `side-chat:${chat.id}` === tab),
      ),
    );
    mobileSidePanelStore.reconcile(surfaceKey, available);
  }, [sideChats, surfaceKey]);
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
  const sideViewAction: AppBarAction = {
    accessibilityLabel: "Open side view",
    icon: "square.split.2x1",
    onPress: () => setSheet("surfaces"),
  };
  const actions: AppBarAction[] = isAndroid
    ? [sideViewAction]
    : [
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
          ...sideViewAction,
        },
      ];
  const menus: AppBarMenu[] = [];
  const dismiss = () => setSheet(null);
  const completeDismiss = (action = pendingDismissedAction) => {
    runAfterModalDismiss(action);
    setPendingDismissedAction(null);
    setSkipDismissAnimation(false);
  };
  const openLineageAfterDismiss = () => {
    if (!props.onOpenLineage) return;
    if (isAndroid) {
      activateSurface("lineage");
      return;
    }
    setSkipDismissAnimation(true);
    const action = deferUntilModalDismiss(props.onOpenLineage);
    setPendingDismissedAction(() => action);
    dismiss();
    if (Platform.OS !== "ios") requestAnimationFrame(() => completeDismiss(action));
  };
  const openFiles = () => {
    if (isAndroid) {
      activateSurface("files");
      return;
    }
    dismiss();
    props.onOpenFilesInspector();
  };
  const openGit = () => {
    if (isAndroid) {
      activateSurface("diff");
      return;
    }
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
    canOpenBrowser: props.canOpenBrowser === true && props.onOpenBrowserPreview !== undefined,
    isGitRepo: props.gitControls.gitStatus?.isRepo ?? false,
    hasPullRequest: Boolean(props.gitControls.gitStatus?.pr),
    hasSideChat: sideChats.length > 0,
    isAndroid: isAndroid,
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
    lineage: "person.2",
  } as const;
  const surfaceHandlers: Partial<Record<MobileSurfaceTabId, () => void>> = {
    browser: () => props.onOpenBrowserPreview?.(),
    terminal: () => {
      dismiss();
      openTerminal();
    },
    files: openFiles,
    diff: runGitItem(reviewItem) ?? openGit,
    "pull-request": openGit,
    "linked-pull-requests": openGit,
  };
  const surfaceLabels: Record<MobileSurfaceTabId, string> = {
    browser: "Browser",
    terminal: "Terminal",
    files: "Files",
    diff: "Diff",
    "pull-request": "Pull request",
    "linked-pull-requests": "Linked pull requests",
    device: "Device",
    lineage: "Previous agents",
  };
  const surfaceLabel = (tab: MobileSidePanelTabId) => {
    if (isMobileSideChatTab(tab))
      return sideChats.find((chat) => `side-chat:${chat.id}` === tab)?.title ?? "Side chat";
    if (isMobileAgentTab(tab))
      return mobileSidePanelThreadLabel(tab, String(props.gitControls.environmentId)) ?? "Agent";
    return surfaceLabels[tab];
  };
  const activateSurface = (id: MobileSidePanelTabId) => {
    mobileSidePanelStore.open(surfaceKey, id);
    if (isAndroid) {
      setSheet("surfaces");
      return;
    }
    dismiss();
    if (isMobileSideChatTab(id)) {
      const sideChat = sideChats.find((chat) => `side-chat:${chat.id}` === id);
      if (sideChat)
        openLinkedThread({
          environmentId: String(props.gitControls.environmentId),
          threadId: String(sideChat.id),
        });
    } else if (isMobileAgentTab(id)) {
      const target = mobileAgentTabTarget(id)!;
      openLinkedThread({ environmentId: target.environmentId, threadId: target.threadId });
      return;
    }
    if (isMobileSurfaceTab(id)) surfaceHandlers[id]?.();
  };

  const panelContent = (
    <View
      className="flex-1 bg-screen"
      style={isAndroid ? undefined : { paddingTop: insets.top + 20 }}
    >
      {sheet === "surfaces" || (isAndroid && sheet === "surface-list") ? (
        <View className="flex-row items-center gap-2 border-b border-border pb-3 pl-4 pr-3">
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            className="flex-1"
            contentContainerClassName="items-center gap-2"
          >
            {surfaceTabs.tabs.map((tab) => (
              <View key={tab} className="flex-row items-center rounded-full bg-subtle">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${surfaceLabel(tab)}`}
                  accessibilityState={{ selected: surfaceTabs.activeTab === tab }}
                  onPress={() => {
                    mobileSidePanelStore.select(surfaceKey, tab);
                    if (isAndroid) return;
                    dismiss();
                    if (isMobileSideChatTab(tab)) {
                      const sideChat = sideChats.find((chat) => `side-chat:${chat.id}` === tab);
                      if (sideChat)
                        openLinkedThread({
                          environmentId: String(props.gitControls.environmentId),
                          threadId: String(sideChat.id),
                        });
                    } else if (isMobileAgentTab(tab)) {
                      const target = mobileAgentTabTarget(tab)!;
                      openLinkedThread({
                        environmentId: target.environmentId,
                        threadId: target.threadId,
                      });
                    } else if (isMobileSurfaceTab(tab)) {
                      surfaceHandlers[tab]?.();
                    }
                  }}
                  className="py-2 pl-3 pr-1.5 active:opacity-70"
                >
                  <AppText className="text-xs font-t3-medium text-foreground">
                    {surfaceLabel(tab)}
                  </AppText>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Close ${surfaceLabel(tab)} tab`}
                  onPress={() => mobileSidePanelStore.close(surfaceKey, tab)}
                  className="px-2 py-2 active:opacity-70"
                  hitSlop={8}
                >
                  <SymbolView name="xmark" size={11} tintColorClassName="accent-icon-muted" />
                </Pressable>
              </View>
            ))}
          </ScrollView>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add a surface"
            onPress={() => setSheet("surface-list")}
            className="h-9 w-9 items-center justify-center rounded-full bg-subtle active:opacity-70"
          >
            <SymbolView name="plus" size={17} tintColorClassName="accent-icon-muted" />
          </Pressable>
          {isAndroid ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Return to chat"
              onPress={dismiss}
              className="h-9 w-9 items-center justify-center rounded-full bg-subtle active:opacity-70"
            >
              <SymbolView name="xmark" size={16} tintColorClassName="accent-icon-muted" />
            </Pressable>
          ) : null}
        </View>
      ) : (
        <View className="flex-row items-center justify-between border-b border-border px-5 pb-4">
          <AppText className="text-lg font-semibold text-foreground">
            {sheet === "details"
              ? "Thread details"
              : sheet === "surface-list"
                ? "Open a surface"
                : "Surfaces"}
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
      )}
      {sheet === "surfaces" && isAndroid && surfaceTabs.activeTab ? (
        <View className="flex-1">
          <InlineSidePanelNavigator identity={`${surfaceKey}:${surfaceTabs.activeTab}`}>
            {props.renderSidePanelSurface?.(
              surfaceTabs.activeTab,
              sideChats[0] ? String(sideChats[0].id) : undefined,
            ) ?? (
              <View className="flex-1 items-center justify-center px-6">
                <AppText className="text-center text-sm text-foreground-muted">
                  {surfaceLabel(surfaceTabs.activeTab)} is unavailable in this view.
                </AppText>
              </View>
            )}
          </InlineSidePanelNavigator>
        </View>
      ) : (
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
                props.onOpenLineage ? openLineageAfterDismiss : undefined,
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
          ) : sheet === "surface-list" ? (
            <>
              {surfaceRow("Thread details", "list.number", () => setSheet("details"))}
              {surfaceAvailability.map((item) =>
                surfaceRow(
                  item.label,
                  surfaceIcons[item.id],
                  item.available &&
                    (isAndroid || (item.id !== "linked-pull-requests" && item.id !== "device"))
                    ? () => {
                        if (item.id === "side-chat") {
                          const sideChat = sideChats[0];
                          if (sideChat) activateSurface(`side-chat:${sideChat.id}`);
                        } else {
                          activateSurface(item.id);
                        }
                      }
                    : undefined,
                  item.available ? undefined : item.reason,
                ),
              )}
              {sideChats.map((sideChat) =>
                surfaceRow(sideChat.title, surfaceIcons["side-chat"], () =>
                  activateSurface(`side-chat:${sideChat.id}`),
                ),
              )}
              {isAndroid
                ? surfaceRow("Previous agents", surfaceIcons.lineage, () =>
                    activateSurface("lineage"),
                  )
                : null}
              {props.onStartNewSideChat
                ? surfaceRow("New side chat", "plus", async () => {
                    const tab = await props.onStartNewSideChat?.();
                    if (tab) activateSurface(tab);
                  })
                : null}
            </>
          ) : surfaceTabs.tabs.length === 0 ? (
            <AppText className="px-4 py-6 text-center text-sm text-foreground-muted">
              No surfaces open. Add one to get started.
            </AppText>
          ) : (
            <AppText className="px-4 py-6 text-center text-sm text-foreground-muted">
              Choose an open surface above or add another.
            </AppText>
          )}
        </ScrollView>
      )}
    </View>
  );

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
      {isAndroid ? (
        <View
          pointerEvents={sheet === null ? "none" : "auto"}
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            zIndex: 20,
            display: sheet === null ? "none" : "flex",
          }}
        >
          {panelContent}
        </View>
      ) : (
        <Modal
          visible={sheet !== null}
          animationType={skipDismissAnimation ? "none" : "slide"}
          presentationStyle="pageSheet"
          onRequestClose={dismiss}
          onDismiss={() => completeDismiss()}
        >
          {panelContent}
        </Modal>
      )}
    </>
  );
}
