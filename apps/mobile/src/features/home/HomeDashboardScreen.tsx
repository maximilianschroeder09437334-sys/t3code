import { useAtomValue } from "@effect/atom-react";
import {
  countHomeDashboardRows,
  filterHomeDashboardRows,
  type HomeDashboardSection,
} from "@t3tools/client-runtime/state/homeDashboard";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { ProviderApprovalDecision } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";
import { BackHandler, Pressable, ScrollView, TextInput, View } from "react-native";
import ReanimatedSwipeable from "react-native-gesture-handler/ReanimatedSwipeable";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { useAtomCommand } from "../../state/use-atom-command";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useThreadListNow } from "../threads/use-thread-list-now";
import { deriveMobileHomeRows } from "./homeDashboardRows";
import { composerDraftHasUserContent, useComposerDraft } from "../../state/use-composer-drafts";
import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";
import { CustomSnoozeSheet } from "../threads/CustomSnoozeSheet";
import {
  resolveThreadListV2SnoozeMenuSelection,
  resolveThreadListV2SnoozePresets,
} from "../threads/threadListV2";
import { Menu } from "../../components/ui/Menu";
import type { MenuAction } from "@react-native-menu/menu";

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

export function HomeDashboardScreen(props: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly delegatedUnderParent: ReadonlySet<string>;
  readonly onBack: () => void;
  readonly onOpenThread: (thread: EnvironmentThreadShell) => void;
  readonly onSettleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onSnoozeThread: (thread: EnvironmentThreadShell, until: string) => Promise<boolean>;
  readonly onSendNewThread: (project: EnvironmentProject, message: string) => void;
}) {
  const now = useThreadListNow(props.threads);
  // Home replaces the list and its app bar, so it clears the status bar itself.
  const [section, setSection] = useState<HomeDashboardSection | "all">("all");
  const [projectKey, setProjectKey] = useState("all");
  const [selectedProject, setSelectedProject] = useState<EnvironmentProject | null>(null);
  const [newThreadMessage, setNewThreadMessage] = useState("");
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
  useEffect(() => {
    // Android Back closes Home instead of leaving the app.
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      onBack();
      return true;
    });
    return () => subscription.remove();
  }, [onBack]);
  const composerProject =
    selectedProject ?? props.projects.find((project) => project.archivedAt == null) ?? null;

  return (
    <View className="flex-1 bg-screen">
      <ScrollView className="flex-1" contentContainerClassName="gap-4 px-4 pb-4 pt-3">
        <View className="flex-row items-center gap-3">
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
          <View className="flex-1 gap-0.5">
            <Text className="text-xl font-semibold text-foreground">Home</Text>
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
          </View>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} className="max-h-10">
          <View className="flex-row gap-2">
            {[
              { key: "all", title: `All ${rows.length}` },
              ...projectsWithRows.map((project) => ({
                key: scopedProjectKey(project.environmentId, project.id),
                title: project.title,
              })),
            ].map((project) => (
              <Pressable
                key={project.key}
                onPress={() => setProjectKey(project.key)}
                className={`rounded-full border px-3 py-2 ${projectKey === project.key ? "border-foreground" : "border-border"}`}
              >
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
                    <Text className="text-xs text-foreground-secondary">
                      {projectRows[0]?.projectName}
                    </Text>
                    {projectRows.map((row) => (
                      <HomeDashboardRow
                        key={row.thread.id}
                        thread={row.thread}
                        section={group}
                        now={now}
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
      <View className="gap-2 border-t border-border px-3 py-2">
        <Menu
          actions={props.projects
            .filter((project) => project.archivedAt == null)
            .map((project) => ({
              id: scopedProjectKey(project.environmentId, project.id),
              title: project.title,
              state:
                composerProject?.environmentId === project.environmentId &&
                composerProject.id === project.id
                  ? "on"
                  : "off",
            }))}
          onPressAction={({ nativeEvent }) => {
            setSelectedProject(
              props.projects.find(
                (project) =>
                  scopedProjectKey(project.environmentId, project.id) === nativeEvent.event,
              ) ?? null,
            );
          }}
        >
          <Pressable
            accessibilityRole="button"
            className="flex-row items-center gap-2 self-start rounded-full border border-border px-3 py-2"
          >
            <Text className="text-xs text-foreground">
              {composerProject?.title ?? "Choose project"}
            </Text>
            <SymbolView
              name="chevron.down"
              size={12}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
          </Pressable>
        </Menu>
        <View className="flex-row items-center gap-2 rounded-xl border border-border px-3 py-2">
          <TextInput
            accessibilityLabel="New thread message"
            placeholder="Ask anything"
            placeholderTextColor="#8b8b8b"
            value={newThreadMessage}
            onChangeText={setNewThreadMessage}
            multiline
            className="max-h-24 min-h-9 flex-1 text-sm text-foreground"
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send message"
            disabled={!composerProject || newThreadMessage.trim().length === 0}
            onPress={() => {
              const message = newThreadMessage.trim();
              if (!composerProject || !message) return;
              props.onSendNewThread(composerProject, message);
              setNewThreadMessage("");
            }}
            className="rounded-full bg-primary px-3 py-2 disabled:opacity-40"
          >
            <Text className="text-xs text-primary-foreground">Send</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function HomeDashboardRow(props: {
  readonly thread: EnvironmentThreadShell;
  readonly section: HomeDashboardSection;
  readonly now: string;
  readonly onOpen: () => void;
  readonly onSettle: () => Promise<boolean>;
  readonly onSnooze: (until: string) => Promise<boolean>;
}) {
  const draft = useComposerDraft(scopedThreadKey(props.thread.environmentId, props.thread.id));
  const hasUnsentDraft = composerDraftHasUserContent(draft);
  const actions = () => (
    <View className="h-full flex-row items-center gap-2 px-2" style={{ width: 168 }}>
      <View className="w-[72px] items-center justify-center rounded-xl border border-border bg-secondary">
        <HomeSnoozeMenu now={props.now} onSnooze={props.onSnooze} />
      </View>
      <Pressable
        accessibilityRole="button"
        onPress={() => void props.onSettle()}
        className="w-[72px] items-center justify-center rounded-xl bg-primary"
      >
        <Text className="text-xs text-primary-foreground">Settle</Text>
      </Pressable>
    </View>
  );
  return (
    <ReanimatedSwipeable renderRightActions={actions} overshootRight={false}>
      <Pressable
        onPress={props.onOpen}
        className="gap-2 rounded-xl border border-border bg-card px-3 py-3"
      >
        <View className="flex-row items-center gap-2">
          <Text numberOfLines={1} className="flex-1 text-sm font-semibold text-foreground">
            {props.thread.title || "New thread"}
          </Text>
          {hasUnsentDraft ? (
            <Text className="text-xs font-semibold text-adaptive-amber-700-300">Draft</Text>
          ) : null}
          <Text className={`${sectionColor[props.section]} text-xs`}>
            {ageLabel(props.thread, props.section, props.now)}
          </Text>
        </View>
        {/* Only rows that need you read the thread's requests; that subscribes to the thread. */}
        {props.section === "needs" ? <HomeDashboardRequest thread={props.thread} /> : null}
      </Pressable>
    </ReanimatedSwipeable>
  );
}

function HomeSnoozeMenu(props: {
  readonly now: string;
  readonly onSnooze: (until: string) => Promise<boolean>;
}) {
  const [customOpen, setCustomOpen] = useState(false);
  const presets = resolveThreadListV2SnoozePresets({
    secondary: "snooze",
    now: props.now,
    presets: undefined,
  });
  const actions = [
    ...presets.map((preset) => ({
      id: `snooze:${preset.id}`,
      title: preset.label,
      subtitle: preset.whenLabel,
    })),
    { id: "snooze:custom", title: "Custom…" },
  ] satisfies MenuAction[];
  return (
    <>
      <Menu
        actions={actions}
        onPressAction={({ nativeEvent }) => {
          if (nativeEvent.event === "snooze:custom") setCustomOpen(true);
          else {
            const selection = resolveThreadListV2SnoozeMenuSelection({
              event: nativeEvent.event,
              displayedPresets: presets,
              now: new Date(),
              presets: undefined,
            });
            if (selection._tag === "selected") void props.onSnooze(selection.preset.snoozedUntil);
          }
        }}
      >
        <Pressable accessibilityRole="button" className="items-center justify-center px-2 py-2.5">
          <Text className="text-xs text-foreground">Snooze</Text>
        </Pressable>
      </Menu>
      {customOpen ? (
        <CustomSnoozeSheet
          onClose={() => setCustomOpen(false)}
          onSnooze={(until) => {
            setCustomOpen(false);
            void props.onSnooze(until);
          }}
        />
      ) : null}
    </>
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
