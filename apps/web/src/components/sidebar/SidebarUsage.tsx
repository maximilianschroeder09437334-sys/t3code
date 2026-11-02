import { useEffect, useEffectEvent } from "react";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import {
  collectLimitAccounts,
  collectLimitPools,
  displayLimitWindows,
  formatDuration,
  paceRemainingPercent,
} from "@t3tools/shared/usageLimits";
import { environmentPresentations } from "../../state/presentation";
import { useNowMinute } from "../../hooks/useNowMinute";

export function SidebarUsage() {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const now = Date.parse(`${useNowMinute()}Z`);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const autoRefresh = useEffectEvent(() => {
    if (document.visibilityState !== "visible") return;
    for (const [environmentId, presentation] of presentations) {
      if (presentation.connection.phase !== "connected") continue;
      void refreshUsageLimits(
        environmentId,
        () => refreshProviders({ environmentId, input: {} }),
        true,
      ).catch(() => undefined);
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes cached provider limits while the sidebar is visible
  useEffect(() => {
    if (now && presentations.size) autoRefresh();
  }, [now, presentations]);
  const rows = collectLimitPools(collectLimitAccounts(presentations), now).flatMap((pool) =>
    displayLimitWindows(pool).map((window) => ({ driver: pool.driver, window })),
  );
  if (rows.length === 0) return null;
  return (
    <Link
      to="/usage"
      title="Time until reset and percentage remaining. Open usage limits."
      className="flex flex-col gap-2 px-3 py-2 hover:bg-sidebar-row-hover"
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
          <div
            key={`${driver}:${window.kind}:${window.id}`}
            className="flex min-w-0 flex-col gap-1"
          >
            <div className="flex justify-between gap-2 text-xs">
              <span className="truncate text-sidebar-muted-foreground">
                {`${driver === "codex" ? "Codex" : driver} ${window.label}`}
              </span>
              <span className="shrink-0 tabular-nums">
                {reset === undefined ? "" : `${formatDuration(reset - now)} / `}
                {Math.round(window.remainingPercent)}%{stale ? " stale" : ""}
              </span>
            </div>
            <div className="relative h-1.5 overflow-hidden rounded-full bg-sidebar-row-hover">
              <div
                className="h-full rounded-full bg-sidebar-foreground"
                style={{ width: `${Math.max(0, Math.min(100, window.remainingPercent))}%` }}
              />
              {pace === null ? null : (
                <div
                  className="absolute inset-y-0 w-0.5 bg-primary"
                  style={{ left: `${Math.max(0, Math.min(99, pace))}%` }}
                />
              )}
            </div>
          </div>
        );
      })}
    </Link>
  );
}
