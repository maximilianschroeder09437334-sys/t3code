import { AppBar } from "../../components/ui/AppBar";
import type { AppBarAction, AppBarMenu } from "../../components/ui/AppBar.types";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import type { ThreadInspectorMode } from "./thread-inspector-navigation";
import { useWorkspaceBackNavigation } from "../layout/workspace/useAndroidWorkspaceNavigation";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { useState } from "react";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText } from "../../components/ui/AppText";
import type { ThreadGitControlsProps } from "./ThreadGitControls";
import { mobileThreadSurfaces } from "./threadHeader.logic";

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
}) {
  const goBack = useWorkspaceBackNavigation();
  const { startNewTask } = useAdaptiveWorkspaceLayout();
  const [sheet, setSheet] = useState<"details" | "surfaces" | null>(null);
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
      onPress: props.gitControls.onOpenNewTerminal,
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
      props.gitControls.onOpenNewTerminal();
    },
    files: openFiles,
    diff: openGit,
    "pull-request": openGit,
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
                  openFiles,
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
                {surfaceRow("Add project script", "plus", openGit)}
                {surfaceRow(
                  `Branch · ${props.gitControls.gitStatus?.refName ?? props.gitControls.currentBranch ?? "Detached HEAD"}`,
                  "arrow.triangle.branch",
                  openGit,
                )}
                {surfaceRow(
                  "Push repository",
                  "arrow.up",
                  () => {
                    dismiss();
                    void props.gitControls.onRunAction({ action: "push" });
                  },
                  "Publish local commits to the remote",
                )}
                {surfaceRow(
                  `Changes · +${props.gitControls.gitStatus?.workingTree?.insertions ?? 0} / −${props.gitControls.gitStatus?.workingTree?.deletions ?? 0}`,
                  "arrow.left.arrow.right",
                  openGit,
                )}
                {surfaceRow("Previous agents", "person.2", openGit, "Lineage")}
                {surfaceRow(
                  "Context",
                  "chart.bar",
                  undefined,
                  "Usage details are unavailable on this mobile view",
                )}
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
