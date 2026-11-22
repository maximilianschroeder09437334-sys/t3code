import { useAtomValue } from "@effect/atom-react";
import { useResolveClassNames } from "uniwind";
import {
  countHomeDashboardRows,
  filterHomeDashboardRows,
  type HomeDashboardSection,
} from "@t3tools/client-runtime/state/homeDashboard";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProviderApprovalDecision, ThreadId } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import {
  BackHandler,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { useContentTopInset } from "../../components/ui/useBarInset";
import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";
import { threadListEnvironmentsAtom } from "../../state/presentation";
import { useAtomCommand } from "../../state/use-atom-command";
import { composerDraftHasUserContent, useComposerDraft } from "../../state/use-composer-drafts";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { CustomSnoozeSheet } from "../threads/CustomSnoozeSheet";
import { setHomeComposerOpen } from "../threads/new-task-flow-state";
import { ThreadDraftTag } from "../threads/ThreadDraftTag";
import {
  resolveThreadListV2SnoozeMenuSelection,
  resolveThreadListV2SnoozePresets,
} from "../threads/threadListV2";
import { useThreadListNow } from "../threads/use-thread-list-now";
import { HomeComposer } from "./HomeComposer";
import { deriveMobileHomeRows } from "./homeDashboardRows";
import { ThreadSwipeable } from "./thread-swipe-actions";
import { ProjectFavicon } from "../../components/ProjectFavicon";

const sectionColor: Record<HomeDashboardSection, string> = {
  needs: "text-warning-foreground",
  done: "text-adaptive-emerald-600-400",
  running: "text-adaptive-sky-600-400",
};

const sectionTitle: Record<HomeDashboardSection, string> = {
  needs: "Needs you",
  done: "Done since you looked",
  running: "Running",
};

function ageLabel(thread: EnvironmentThreadShell, section: HomeDashboardSection, now: string) {
  const timestamp =
    section === "needs"
      ? (thread.pendingUserInputAt ?? thread.latestRun?.completedAt ?? thread.updatedAt)
      : section === "running"
        ? (thread.latestRun?.startedAt ?? thread.latestRun?.requestedAt ?? thread.updatedAt)
        : (thread.latestRun?.completedAt ?? thread.updatedAt);
  const from = Date.parse(timestamp);
  const to = Date.parse(now);
  const minutes =
    Number.isFinite(from) && Number.isFinite(to)
      ? Math.max(0, Math.floor((to - from) / 60_000))
      : 0;
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(minutes / 1440);
  const age =
    minutes < 60
      ? `${minutes} min`
      : hours < 24
        ? `${hours} h`
        : days < 7
          ? `${days} ${days === 1 ? "day" : "days"}`
          : `${Math.floor(days / 7)} ${Math.floor(days / 7) === 1 ? "week" : "weeks"}`;
  return section === "needs"
    ? `waiting ${age}`
    : section === "running"
      ? `running ${age}`
      : `done ${age} ago`;
}

function HomeBackButton(props: { readonly onBack: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Back to Chats"
      onPress={props.onBack}
      hitSlop={12}
      className="py-1"
    >
      <SymbolView
        name="arrow.left"
        size={22}
        tintColorClassName="accent-foreground"
        type="monochrome"
      />
    </Pressable>
  );
}

export function HomeDashboardScreen(props: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly delegatedUnderParent: ReadonlySet<string>;
  readonly onBack: () => void;
  readonly onOpenThread: (thread: EnvironmentThreadShell) => void;
  readonly onOpenStartedThread: (thread: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  }) => void;
  readonly onSettleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onSnoozeThread: (thread: EnvironmentThreadShell, until: string) => Promise<boolean>;
}) {
  const now = useThreadListNow(props.threads);
  // Android shows Home's title in the workspace app bar, right under the status bar, like Chats.
  // iOS keeps it in the content, below the transparent native header.
  const contentTopInset = useContentTopInset();
  const [section, setSection] = useState<HomeDashboardSection | "all">("all");
  const [projectKey, setProjectKey] = useState("all");
  const [composerHeight, setComposerHeight] = useState(0);
  const { snoozePresetsByEnvironmentId } = useAtomValue(threadListEnvironmentsAtom);
  const rows = useMemo(
    () =>
      deriveMobileHomeRows({
        threads: props.threads,
        projects: props.projects,
        now,
        delegatedUnderParent: props.delegatedUnderParent,
      }),
    [now, props.delegatedUnderParent, props.projects, props.threads],
  );
  const counts = countHomeDashboardRows(rows);
  const visible = filterHomeDashboardRows(rows, section, projectKey);
  const projectsWithRows = props.projects.filter((project) =>
    rows.some((row) => row.projectKey === scopedProjectKey(project.environmentId, project.id)),
  );
  const { onBack } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds the Android hardware Back listener while Home is mounted, so Back closes Home
  useEffect(() => {
    // Android Back closes Home instead of leaving the app.
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      onBack();
      return true;
    });
    return () => subscription.remove();
  }, [onBack]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the root new-task flow provider to serve the Home composer while Home is mounted
  useLayoutEffect(() => {
    setHomeComposerOpen(true);
    return () => setHomeComposerOpen(false);
  }, []);

  const summary = (
    <View className="flex-row flex-wrap gap-x-1">
      {(["needs", "done", "running"] as const)
        .filter((key) => counts[key] > 0)
        .map((key, index) => (
          <Pressable key={key} onPress={() => setSection(section === key ? "all" : key)}>
            <Text
              className={`${sectionColor[key]} text-xs ${section === key ? "font-semibold underline" : ""}`}
            >
              {index ? "· " : ""}
              {counts[key]} {key === "needs" ? "need you" : key}
            </Text>
          </Pressable>
        ))}
    </View>
  );

  return (
    <View className="flex-1 bg-screen">
      {Platform.OS === "android" ? (
        <AppBar
          title="Home"
          titleContent={
            <View className="flex-row items-center gap-4">
              <HomeBackButton onBack={props.onBack} />
              <Text textRole="title" numberOfLines={1} className="text-header-foreground">
                Home
              </Text>
            </View>
          }
        />
      ) : null}
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-4 px-4"
        contentContainerStyle={{
          paddingTop: Platform.OS === "android" ? 12 : contentTopInset + 12,
          paddingBottom: composerHeight + 16,
        }}
        keyboardShouldPersistTaps="handled"
      >
        {Platform.OS === "android" ? (
          summary
        ) : (
          <View className="flex-row items-center gap-3">
            <HomeBackButton onBack={props.onBack} />
            <View className="flex-1 gap-0.5">
              <Text className="text-xl font-semibold text-foreground">Home</Text>
              {summary}
            </View>
          </View>
        )}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} className="max-h-10">
          <View className="flex-row gap-2">
            {[
              {
                key: "all",
                title: `All ${rows.length}`,
                project: null as EnvironmentProject | null,
              },
              ...projectsWithRows.map((project) => ({
                key: scopedProjectKey(project.environmentId, project.id),
                title: project.title,
                project: project as EnvironmentProject | null,
              })),
            ].map((project) => (
              <Pressable
                key={project.key}
                onPress={() => setProjectKey(project.key)}
                className={`flex-row items-center gap-1.5 rounded-full border px-3 py-2 ${projectKey === project.key ? "border-foreground" : "border-border"}`}
              >
                {project.project ? (
                  <ProjectFavicon
                    environmentId={project.project.environmentId}
                    projectTitle={project.project.title}
                    workspaceRoot={project.project.workspaceRoot}
                    faviconPath={project.project.faviconPath}
                    projectIcon={project.project.projectIcon}
                    size={16}
                  />
                ) : (
                  <SymbolView
                    name="square.grid.2x2"
                    size={14}
                    tintColorClassName="accent-icon-muted"
                  />
                )}
                <Text className="text-xs text-foreground">{project.title}</Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
        {visible.length === 0 ? (
          <Text className="py-8 text-center text-sm text-foreground-muted">
            Nothing needs you right now.
          </Text>
        ) : null}
        {(["needs", "done", "running"] as const).map((group) => {
          const groupRows = visible.filter((row) => row.section === group);
          if (groupRows.length === 0) return null;
          return (
            <View key={group} className="gap-2">
              <Text className={`${sectionColor[group]} text-sm font-semibold`}>
                {sectionTitle[group]} {groupRows.length}
              </Text>
              {[...new Set(groupRows.map((row) => row.projectKey))].map((key) => {
                const projectRows = groupRows.filter((row) => row.projectKey === key);
                return (
                  <View key={key} className="gap-2">
                    <View className="flex-row items-center gap-1.5">
                      {(() => {
                        const project = props.projects.find(
                          (item) => scopedProjectKey(item.environmentId, item.id) === key,
                        );
                        return project ? (
                          <ProjectFavicon
                            environmentId={project.environmentId}
                            projectTitle={project.title}
                            workspaceRoot={project.workspaceRoot}
                            faviconPath={project.faviconPath}
                            projectIcon={project.projectIcon}
                            size={15}
                          />
                        ) : (
                          <SymbolView
                            name="folder"
                            size={14}
                            tintColorClassName="accent-icon-muted"
                          />
                        );
                      })()}
                      <Text className="text-xs text-foreground-secondary">
                        {projectRows[0]?.projectName}
                      </Text>
                    </View>
                    {projectRows.map((row) => (
                      <HomeDashboardRow
                        key={row.thread.id}
                        thread={row.thread}
                        section={group}
                        now={now}
                        snoozePresets={snoozePresetsByEnvironmentId.get(row.thread.environmentId)}
                        onOpen={() => props.onOpenThread(row.thread)}
                        onSettle={() => props.onSettleThread(row.thread)}
                        onSnooze={(until) => props.onSnoozeThread(row.thread, until)}
                      />
                    ))}
                  </View>
                );
              })}
            </View>
          );
        })}
      </ScrollView>
      <HomeComposer
        projects={props.projects}
        onThreadStarted={props.onOpenStartedThread}
        onHeightChange={setComposerHeight}
      />
    </View>
  );
}

function HomeDashboardRow(props: {
  readonly thread: EnvironmentThreadShell;
  readonly section: HomeDashboardSection;
  readonly now: string;
  readonly snoozePresets: Parameters<typeof resolveThreadListV2SnoozePresets>[0]["presets"];
  readonly onOpen: () => void;
  readonly onSettle: () => Promise<boolean>;
  readonly onSnooze: (until: string) => Promise<boolean>;
}) {
  const { thread } = props;
  const draft = useComposerDraft(scopedThreadKey(thread.environmentId, thread.id));
  const hasUnsentDraft = composerDraftHasUserContent(draft);
  const [customSnoozeOpen, setCustomSnoozeOpen] = useState(false);
  const { width: windowWidth } = useWindowDimensions();
  const screenColor =
    StyleSheet.flatten(useResolveClassNames("bg-screen"))?.backgroundColor ?? "transparent";
  const title = thread.title || "New thread";
  // The Chats list's swipe actions: Settle, and Snooze with its preset menu and Custom….
  const snoozePresets = resolveThreadListV2SnoozePresets({
    secondary: "snooze",
    now: props.now,
    presets: props.snoozePresets,
  });
  const snoozeActions: MenuAction[] = [
    ...snoozePresets.map((preset) => ({
      id: `snooze:${preset.id}`,
      title: preset.label,
      subtitle: preset.whenLabel,
    })),
    { id: "snooze:custom", title: "Custom…" },
  ];
  const handleSnoozeAction = ({
    nativeEvent,
  }: {
    readonly nativeEvent: { readonly event: string };
  }) => {
    if (nativeEvent.event === "snooze:custom") {
      setCustomSnoozeOpen(true);
      return;
    }
    const selection = resolveThreadListV2SnoozeMenuSelection({
      event: nativeEvent.event,
      displayedPresets: snoozePresets,
      now: new Date(),
      presets: props.snoozePresets,
    });
    if (selection._tag === "selected") void props.onSnooze(selection.preset.snoozedUntil);
    else if (selection._tag === "expired") {
      Dialog.alert("Could not snooze thread", "That snooze time has passed. Choose another time.");
    }
  };
  return (
    <View collapsable={false}>
      {customSnoozeOpen ? (
        <CustomSnoozeSheet
          onClose={() => setCustomSnoozeOpen(false)}
          onSnooze={(until) => {
            setCustomSnoozeOpen(false);
            void props.onSnooze(until);
          }}
        />
      ) : null}
      <ThreadSwipeable
        threadKey={`${thread.environmentId}:${thread.id}`}
        threadTitle={title}
        backgroundColor={screenColor}
        fullSwipeAction="primary"
        fullSwipeWidth={windowWidth - 32}
        onDelete={() => {}}
        primaryAction={{
          accessibilityLabel: `Settle ${title}`,
          icon: "checkmark",
          label: "Settle",
          onPress: () => void props.onSettle(),
        }}
        secondaryAction={{
          accessibilityLabel: `Choose when to snooze ${title}`,
          icon: "clock",
          label: "Snooze",
          menu: {
            actions: snoozeActions,
            onPressAction: handleSnoozeAction,
            title: "Snooze until",
          },
          onPress: () => undefined,
        }}
        resetKey={`${thread.settledAt}:${thread.snoozedUntil}`}
      >
        {(close) => (
          <Pressable
            accessibilityRole="button"
            accessibilityHint="Opens the thread. Swipe left for settle and snooze actions."
            onPress={() => {
              close();
              props.onOpen();
            }}
            className="gap-2 rounded-xl border border-border bg-card px-3 py-3"
          >
            <View className="flex-row items-center gap-2">
              <Text numberOfLines={1} className="flex-1 text-sm font-semibold text-foreground">
                {title}
              </Text>
              {hasUnsentDraft ? <ThreadDraftTag /> : null}
              <Text className={`${sectionColor[props.section]} text-xs`}>
                {ageLabel(thread, props.section, props.now)}
              </Text>
            </View>
            {/* Only rows that need you read the thread's requests; that subscribes to the thread. */}
            {props.section === "needs" ? <HomeDashboardRequest thread={thread} /> : null}
          </Pressable>
        )}
      </ThreadSwipeable>
    </View>
  );
}

function HomeDashboardRequest(props: { readonly thread: EnvironmentThreadShell }) {
  const pending = useAtomValue(
    environmentThreadDetails.pendingRequestsAtom({
      environmentId: props.thread.environmentId,
      threadId: props.thread.id,
    }),
  );
  const respondApproval = useAtomCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const respondInput = useAtomCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [answers, setAnswers] = useState<Record<string, string | ReadonlyArray<string>>>({});
  const approval = pending?.approvals[0];
  const input = pending?.userInputs[0];
  const approve = async (decision: ProviderApprovalDecision) => {
    if (!approval) return;
    const result = await respondApproval({
      environmentId: props.thread.environmentId,
      input: {
        threadId: props.thread.id,
        requestId: approval.requestId,
        decision,
        ...(decision === "decline" && reason.trim() ? { feedback: reason.trim() } : {}),
      },
    });
    if (result._tag === "Success") {
      setRejecting(false);
      setReason("");
    }
  };
  const submitAnswers = async (values: Record<string, string | ReadonlyArray<string>>) => {
    if (!input) return;
    const completed = Object.fromEntries(
      input.questions.map((question) => [
        question.id,
        values[question.id] ?? question.initialAnswer ?? (question.multiSelect ? [] : ""),
      ]),
    );
    if (
      input.questions.some((question) => {
        if (question.required === false) return false;
        const answer = completed[question.id];
        return typeof answer === "string"
          ? answer.trim().length === 0
          : !answer || answer.length === 0;
      })
    )
      return;
    const result = await respondInput({
      environmentId: props.thread.environmentId,
      input: { threadId: props.thread.id, requestId: input.requestId, answers: completed },
    });
    if (result._tag === "Success") setAnswers({});
  };
  const chooseAnswer = (
    questionId: string,
    value: string,
    multiSelect: boolean,
    submitImmediately: boolean,
  ) => {
    const current = answers[questionId];
    const nextValue = multiSelect
      ? Array.isArray(current)
        ? current.includes(value)
          ? current.filter((item) => item !== value)
          : [...current, value]
        : [value]
      : value;
    const next = { ...answers, [questionId]: nextValue };
    setAnswers(next);
    if (submitImmediately) void submitAnswers(next);
  };
  return (
    <>
      {approval ? (
        <View className="gap-2">
          <Text className="text-sm text-foreground">{approval.detail ?? approval.requestKind}</Text>
          {rejecting ? (
            <TextInput
              accessibilityLabel="Rejection reason (optional)"
              placeholder="Reason, optional; sent to the thread"
              value={reason}
              onChangeText={setReason}
              className="rounded-lg border border-border px-3 py-2 text-sm text-foreground"
              placeholderTextColor="#8b8b8b"
            />
          ) : null}
          <View className="flex-row flex-wrap gap-2">
            <Pressable
              accessibilityRole="button"
              disabled={approval.responseCapability !== "live"}
              onPress={() => void approve("accept")}
              className="rounded-lg bg-primary px-3 py-2"
            >
              <Text className="text-xs text-primary-foreground">Approve</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={approval.responseCapability !== "live"}
              onPress={() => (rejecting ? void approve("decline") : setRejecting(true))}
              className="rounded-lg border border-danger-border bg-danger px-3 py-2"
            >
              <Text className="text-xs text-danger-foreground">
                {rejecting ? "Send reject" : "Reject"}
              </Text>
            </Pressable>
            {rejecting ? (
              <Pressable onPress={() => setRejecting(false)} className="px-2 py-2">
                <Text className="text-xs text-foreground-secondary">Cancel</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : input ? (
        <View className="gap-2">
          {input.questions.map((question) => (
            <View key={question.id} className="gap-1">
              <Text className="text-sm text-foreground">{question.question}</Text>
              <View className="flex-row flex-wrap gap-2">
                {question.options.map((option) => (
                  <Pressable
                    key={option.value ?? option.label}
                    accessibilityRole="button"
                    accessibilityState={{
                      selected: Array.isArray(answers[question.id])
                        ? answers[question.id]?.includes(option.value ?? option.label)
                        : answers[question.id] === (option.value ?? option.label),
                    }}
                    onPress={() =>
                      chooseAnswer(
                        question.id,
                        option.value ?? option.label,
                        question.multiSelect === true,
                        input.questions.length === 1 && question.multiSelect !== true,
                      )
                    }
                    className="rounded-lg border border-border px-3 py-2"
                  >
                    <Text className="text-xs text-foreground">{option.label}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ))}
          {input.questions.length > 1 ||
          input.questions.some((question) => question.multiSelect) ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => void submitAnswers(answers)}
              className="self-start rounded-lg bg-primary px-3 py-2"
            >
              <Text className="text-xs text-primary-foreground">Send answer</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </>
  );
}
