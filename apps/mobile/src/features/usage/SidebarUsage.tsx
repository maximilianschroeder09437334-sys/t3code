import { useAtomValue } from "@effect/atom-react";
import { useNowMinuteMs } from "../../lib/clock";
import {
  collectLimitAccounts,
  collectLimitPools,
  displayLimitWindows,
  formatDuration,
  paceRemainingPercent,
} from "@t3tools/shared/usageLimits";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { environmentPresentations } from "../../state/presentation";
import { useSelectWorkspaceTab } from "../layout/workspace/useSelectWorkspaceTab";

export function SidebarUsage({ bottomInset = 0 }: { readonly bottomInset?: number }) {
  const selectTab = useSelectWorkspaceTab();
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  // The app-level subscription worker already refreshes limits while active.
  const now = useNowMinuteMs();
  const pools = collectLimitPools(collectLimitAccounts(presentations), now);
  const rows = pools.flatMap((pool) =>
    displayLimitWindows(pool).map((window) => ({ driver: pool.driver, window })),
  );
  if (rows.length === 0) return null;
  return (
    <Pressable
      style={{ marginBottom: bottomInset }}
      accessibilityRole="button"
      accessibilityLabel="Subscription usage limits"
      accessibilityHint="Time until reset and percentage remaining. Open detailed usage limits."
      onPress={() => selectTab("usage")}
      className="gap-2 px-4 py-3 active:opacity-70"
    >
      {rows.map(({ driver, window }) => {
        const reset = window.resets[0]?.at;
        const stale = window.members.some(({ account }) => {
          const checked = Date.parse(account.limits.checkedAt);
          return (
            !Number.isFinite(checked) ||
            now - checked > 10 * 60_000 ||
            !account.environments.some(
              ({ environmentId }) =>
                presentations.get(environmentId)?.connection.phase === "connected",
            )
          );
        });
        const pace =
          window.members.length === 1 ? paceRemainingPercent(window.members[0]!.window, now) : null;
        return (
          <View key={`${driver}:${window.kind}:${window.id}`} className="gap-1">
            <View className="flex-row justify-between gap-2">
              <Text className="shrink text-xs text-foreground-muted" numberOfLines={1}>
                {`${driver === "codex" ? "Codex" : driver === "claudeAgent" ? "Claude" : driver} ${window.label}`}
              </Text>
              <Text className="text-xs font-t3-medium tabular-nums text-foreground">
                {reset === undefined ? "" : `${formatDuration(Math.max(0, reset - now))} / `}
                {Math.round(window.remainingPercent)}%{stale ? " stale" : ""}
              </Text>
            </View>
            <View className="h-1.5 overflow-hidden rounded-full bg-subtle">
              <View
                className="h-full rounded-full bg-foreground"
                style={{ width: `${Math.max(0, Math.min(100, window.remainingPercent))}%` }}
              />
              {pace === null ? null : (
                <View
                  className="absolute top-0 bottom-0 w-0.5 bg-primary"
                  style={{ left: `${Math.max(0, Math.min(99, pace))}%` }}
                />
              )}
            </View>
          </View>
        );
      })}
    </Pressable>
  );
}
