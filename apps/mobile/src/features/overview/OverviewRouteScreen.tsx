import { useAtomValue } from "@effect/atom-react";
import { formatOverviewElapsed } from "@t3tools/client-runtime/state/overview";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useNowMinuteMs } from "../../lib/clock";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { overview } from "../../state/activity";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { UsageLimitsSection } from "../usage/UsageLimitsPooled";

export function OverviewRouteScreen() {
  const selectDetail = useSelectWorkspaceDetail();
  const activity = useAtomValue(overview.activityAtom);
  const needsYou = useAtomValue(overview.needsYouAtom);
  const inFlight = useAtomValue(overview.inFlightAtom);
  const markSeen = useAtomCommand(overview.markSeen);
  const [marking, setMarking] = useState(false);
  const now = useNowMinuteMs();
  return (
    <SettingsScreen title="Overview">
      <ScreenScrollView contentContainerClassName="gap-6 p-5">
        {activity.status.loading ? <Text>Loading activity...</Text> : null}
        {activity.status.unavailable.map((environment) => (
          <Text key={environment.environmentId} className="text-foreground-muted">
            Activity unavailable on {environment.label}; pending requests remain visible.
          </Text>
        ))}
        <View className="gap-3">
          <Text className="text-lg font-t3-medium text-foreground">Needs you</Text>
          {needsYou.length === 0 ? (
            <Text className="text-foreground-muted">
              No pending requests reported. Activity may be incomplete.
            </Text>
          ) : (
            needsYou.map((row) => (
              <Pressable
                key={row.key}
                accessibilityRole="button"
                onPress={() =>
                  selectDetail({
                    name: "Thread",
                    params: {
                      environmentId: row.environmentId,
                      threadId: row.threadId,
                    },
                  })
                }
                className="gap-1 py-2"
              >
                <Text className="font-t3-medium text-foreground">{row.title}</Text>
                <Text className="text-foreground-muted">
                  {row.summary ??
                    (row.reason === "approval"
                      ? "Approval requested"
                      : row.reason === "question"
                        ? "Answer requested"
                        : "Waiting for you")}
                </Text>
                {row.next ? <Text className="text-foreground">{row.next}</Text> : null}
              </Pressable>
            ))
          )}
        </View>
        <View className="gap-3">
          <Text className="text-lg font-t3-medium text-foreground">Features in flight</Text>
          {inFlight.length === 0 ? (
            <Text className="text-foreground-muted">
              No running threads reported. Activity may be incomplete.
            </Text>
          ) : (
            inFlight.map((row) => (
              <Pressable
                key={row.key}
                accessibilityRole="button"
                onPress={() =>
                  selectDetail({
                    name: "Thread",
                    params: {
                      environmentId: row.environmentId,
                      threadId: row.threadId,
                    },
                  })
                }
                className="gap-1 py-2"
              >
                <Text className="font-t3-medium text-foreground">{row.title}</Text>
                <Text className="text-foreground-muted">
                  {row.model} - {formatOverviewElapsed(row.startedAt, now) ?? "Start time unknown"}
                </Text>
                <Text className="text-foreground-muted">
                  {row.context
                    ? `${row.context.usedTokens.toLocaleString()} tokens${row.context.maxTokens === null ? " - window unknown" : ` / ${row.context.maxTokens.toLocaleString()}`}${row.context.usedPercent === null ? "" : ` - ${Math.round(row.context.usedPercent)}%`}`
                    : "Context usage unknown"}
                </Text>
              </Pressable>
            ))
          )}
        </View>
        <View className="gap-3">
          <Text className="text-lg font-t3-medium text-foreground">Since last check-in</Text>
          <Button
            label="Mark seen"
            size="compact"
            loading={marking}
            disabled={activity.seenTargets.length === 0}
            onPress={() => {
              setMarking(true);
              void Promise.all(
                activity.seenTargets.map(({ environmentId, seenSequence }) =>
                  markSeen({ environmentId, input: { seenSequence } }),
                ),
              ).finally(() => setMarking(false));
            }}
          />
          {activity.feed.events.length === 0 ? (
            <Text className="text-foreground-muted">
              No new activity reported. Activity may be incomplete.
            </Text>
          ) : (
            activity.feed.events.map((event) => (
              <Pressable
                key={`${event.environmentId}:${event.sequence}`}
                accessibilityRole="button"
                onPress={() =>
                  selectDetail({
                    name: "Thread",
                    params: {
                      environmentId: event.environmentId,
                      threadId: event.threadId,
                    },
                  })
                }
                className="gap-1 py-2"
              >
                <Text className="text-foreground">{event.summary}</Text>
                <Text className="text-foreground-muted">
                  {event.kind} - {new Date(event.at).toLocaleString()}
                </Text>
              </Pressable>
            ))
          )}
          {activity.feed.truncated ? (
            <Text className="text-foreground-muted">
              Showing recent activity; older events remain in the ledger.
            </Text>
          ) : null}
        </View>
        <View className="gap-3">
          <Text className="text-lg font-t3-medium text-foreground">Usage limits</Text>
          <UsageLimitsSection now={now} failedLabels={[]} selectedEnvironmentIds={null} />
        </View>
      </ScreenScrollView>
    </SettingsScreen>
  );
}
