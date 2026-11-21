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
import { useMemo, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import ReanimatedSwipeable from "react-native-gesture-handler/ReanimatedSwipeable";

import { AppText as Text } from "../../components/ui/AppText";
import { useAtomCommand } from "../../state/use-atom-command";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useThreadListNow } from "../threads/use-thread-list-now";
import { deriveMobileHomeRows } from "./homeDashboardRows";

const sectionColor: Record<HomeDashboardSection, string> = {
  needs: "text-warning-foreground",
  done: "text-success",
  running: "text-info-foreground",
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
  readonly onNewThread: (project: EnvironmentProject) => void;
}) {
  const now = useThreadListNow(props.threads);
  const [section, setSection] = useState<HomeDashboardSection | "all">("all");
  const [projectKey, setProjectKey] = useState("all");
  const [selectedProject, setSelectedProject] = useState<EnvironmentProject | null>(null);
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
    rows.some((row) => row.projectKey === `${project.environmentId}\0${project.id}`),
  );
  const composerProject =
    selectedProject ?? props.projects.find((project) => project.archivedAt == null) ?? null;

  return (
    <View className="flex-1 bg-screen">
      <ScrollView className="flex-1" contentContainerClassName="gap-4 px-4 pb-4 pt-3">
        <View className="gap-1">
          <Pressable accessibilityRole="button" onPress={props.onBack} className="py-1">
            <Text className="text-xs text-foreground-secondary">Back to Chats</Text>
          </Pressable>
          <Text className="text-xl font-semibold text-foreground">Home</Text>
        </View>
        <View className="flex-row flex-wrap gap-2">
          {(["needs", "done", "running"] as const).map((key) =>
            counts[key] > 0 ? (
              <Pressable key={key} onPress={() => setSection(section === key ? "all" : key)}>
                <Text className={`${sectionColor[key]} text-xs font-semibold`}>
                  {counts[key]} {key === "needs" ? "need you" : key}
                </Text>
              </Pressable>
            ) : null,
          )}
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} className="max-h-10">
          <View className="flex-row gap-2">
            {[
              { key: "all", title: `All ${rows.length}` },
              ...projectsWithRows.map((project) => ({
                key: `${project.environmentId}\0${project.id}`,
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
        {(["needs", "done", "running"] as const).map((group) => {
          const groupRows = visible.filter((row) => row.section === group);
          if (groupRows.length === 0) return null;
          return (
            <View key={group} className="gap-2">
              <Text className={`${sectionColor[group]} text-sm font-semibold`}>
                {group === "needs" ? "Needs you" : group[0]!.toUpperCase() + group.slice(1)}
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
                        onSnooze={() =>
                          props.onSnoozeThread(
                            row.thread,
                            new Date(Date.parse(now) + 60 * 60_000).toISOString(),
                          )
                        }
                      />
                    ))}
                  </View>
                );
              })}
            </View>
          );
        })}
      </ScrollView>
      <View className="flex-row items-center gap-2 border-t border-border px-3 py-2">
        <ScrollView horizontal showsHorizontalScrollIndicator={false} className="max-w-[42%]">
          <View className="flex-row gap-1">
            {props.projects
              .filter((project) => project.archivedAt == null)
              .map((project) => (
                <Pressable
                  key={`${project.environmentId}:${project.id}`}
                  onPress={() => setSelectedProject(project)}
                  className={`rounded-full border px-2.5 py-2 ${composerProject?.environmentId === project.environmentId && composerProject.id === project.id ? "border-foreground" : "border-border"}`}
                >
                  <Text className="text-xs text-foreground">{project.title}</Text>
                </Pressable>
              ))}
          </View>
        </ScrollView>
        <Pressable
          accessibilityRole="button"
          onPress={() => composerProject && props.onNewThread(composerProject)}
          className="flex-1 rounded-xl border border-border px-3 py-3"
        >
          <Text className="text-sm text-foreground-muted">Ask anything</Text>
        </Pressable>
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
  readonly onSnooze: () => Promise<boolean>;
}) {
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
  const actions = () => (
    <View className="h-full flex-row" style={{ width: 152 }}>
      <Pressable
        accessibilityRole="button"
        onPress={() => void props.onSnooze()}
        className="w-[76px] items-center justify-center bg-info"
      >
        <Text className="text-xs text-white">Snooze</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        onPress={() => void props.onSettle()}
        className="w-[76px] items-center justify-center bg-success"
      >
        <Text className="text-xs text-white">Settle</Text>
      </Pressable>
    </View>
  );
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
    <ReanimatedSwipeable renderRightActions={actions} overshootRight={false}>
      <Pressable
        onPress={props.onOpen}
        className="gap-2 rounded-xl border border-border bg-card px-3 py-3"
      >
        <View className="flex-row items-center gap-2">
          <Text numberOfLines={1} className="flex-1 text-sm font-semibold text-foreground">
            {props.thread.title || "New thread"}
          </Text>
          <Text className={`${sectionColor[props.section]} text-xs`}>
            {ageLabel(props.thread, props.section, props.now)}
          </Text>
        </View>
        {approval ? (
          <View className="gap-2">
            <Text className="text-sm text-foreground">
              {approval.detail ?? approval.requestKind}
            </Text>
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
                className="rounded-lg bg-accent px-3 py-2"
              >
                <Text className="text-xs text-accent-foreground">Approve</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={approval.responseCapability !== "live"}
                onPress={() => (rejecting ? void approve("decline") : setRejecting(true))}
                className="rounded-lg border border-border px-3 py-2"
              >
                <Text className="text-xs text-foreground">
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
                className="self-start rounded-lg bg-accent px-3 py-2"
              >
                <Text className="text-xs text-accent-foreground">Send answer</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </Pressable>
    </ReanimatedSwipeable>
  );
}
