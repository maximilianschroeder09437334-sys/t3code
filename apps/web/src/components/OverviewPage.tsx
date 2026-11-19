import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { formatOverviewElapsed } from "@t3tools/client-runtime/state/overview";
import { overview } from "../state/activity";
import { useAtomCommand } from "../state/use-atom-command";
import { useNowMinute } from "../hooks/useNowMinute";
import { Button } from "./ui/button";
import { SidebarInset, SidebarTrigger } from "./ui/sidebar";
import { WorkspacePageHeader } from "./WorkspacePageHeader";
import { UsageLimitsSection } from "./usage/UsageLimits";
import type { UsageProviderKind } from "@t3tools/contracts";

const NO_HIDDEN_PROVIDERS: ReadonlySet<UsageProviderKind> = new Set();

export function OverviewPage() {
  const activity = useAtomValue(overview.activityAtom);
  const needsYou = useAtomValue(overview.needsYouAtom);
  const inFlight = useAtomValue(overview.inFlightAtom);
  const markSeen = useAtomCommand(overview.markSeen);
  const [marking, setMarking] = useState(false);
  const now = Date.parse(`${useNowMinute()}Z`);
  return (
    <SidebarInset className="h-dvh min-h-0">
      <WorkspacePageHeader>
        <SidebarTrigger />
        <h1 className="text-sm font-medium">Overview</h1>
      </WorkspacePageHeader>
      <main className="min-h-0 flex-1 overflow-auto scrollbar-gutter-both">
        <div className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-6 sm:px-8">
          {activity.status.loading ? <p role="status">Loading activity…</p> : null}
          {activity.status.unavailable.map((environment) => (
            <p
              key={environment.environmentId}
              role="status"
              className="text-sm text-muted-foreground"
            >
              Activity unavailable on {environment.label}; pending requests remain visible.
            </p>
          ))}
          <section aria-labelledby="overview-needs-you">
            <h2 id="overview-needs-you" className="mb-3 text-base font-medium">
              Needs you
            </h2>
            {needsYou.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No pending requests reported. Activity may be incomplete.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {needsYou.map((row) => (
                  <li key={row.key} className="py-3">
                    <Link
                      to="/$environmentId/$threadId"
                      params={{ environmentId: row.environmentId, threadId: row.threadId }}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {row.title}
                    </Link>
                    <p className="text-sm text-muted-foreground">
                      {row.summary ??
                        (row.reason === "approval"
                          ? "Approval requested"
                          : row.reason === "question"
                            ? "Answer requested"
                            : "Waiting for you")}
                    </p>
                    {row.next ? <p className="text-sm">{row.next}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="overview-in-flight">
            <h2 id="overview-in-flight" className="mb-3 text-base font-medium">
              Features in flight
            </h2>
            {inFlight.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No running threads reported. Activity may be incomplete.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {inFlight.map((row) => (
                  <li
                    key={row.key}
                    className="flex flex-wrap items-center justify-between gap-3 py-3"
                  >
                    <div className="min-w-0">
                      <Link
                        to="/$environmentId/$threadId"
                        params={{ environmentId: row.environmentId, threadId: row.threadId }}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {row.title}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {row.model} ·{" "}
                        {formatOverviewElapsed(row.startedAt, now) ?? "Start time unknown"}
                      </p>
                    </div>
                    <div className="w-44 text-xs tabular-nums text-muted-foreground">
                      {row.context ? (
                        <>
                          <p>
                            {row.context.usedTokens.toLocaleString()} tokens
                            {row.context.maxTokens === null
                              ? " · window unknown"
                              : ` / ${row.context.maxTokens.toLocaleString()}`}
                          </p>
                          {row.context.usedPercent === null ? null : (
                            <progress
                              aria-label={`${row.title} context used`}
                              value={row.context.usedPercent}
                              max={100}
                              className="h-2 w-full"
                            />
                          )}
                        </>
                      ) : (
                        "Context usage unknown"
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="overview-feed">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 id="overview-feed" className="text-base font-medium">
                Since last check-in
              </h2>
              <Button
                variant="outline"
                size="sm"
                disabled={marking || activity.seenTargets.length === 0}
                onClick={async () => {
                  setMarking(true);
                  try {
                    await Promise.all(
                      activity.seenTargets.map(({ environmentId, seenSequence }) =>
                        markSeen({ environmentId, input: { seenSequence } }),
                      ),
                    );
                  } finally {
                    setMarking(false);
                  }
                }}
              >
                {marking ? "Marking…" : "Mark seen"}
              </Button>
            </div>
            {activity.feed.events.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No new activity reported. Activity may be incomplete.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {activity.feed.events.map((event) => (
                  <li key={`${event.environmentId}:${event.sequence}`} className="py-3">
                    <Link
                      to="/$environmentId/$threadId"
                      params={{ environmentId: event.environmentId, threadId: event.threadId }}
                      className="text-sm underline-offset-4 hover:underline"
                    >
                      {event.summary}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {event.kind} · {new Date(event.at).toLocaleString()}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            {activity.feed.truncated ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Showing recent activity; older events remain in the ledger.
              </p>
            ) : null}
          </section>
          <section aria-labelledby="overview-usage">
            <h2 id="overview-usage" className="mb-3 text-base font-medium">
              Usage limits
            </h2>
            <UsageLimitsSection
              selectedEnvironmentIds={null}
              hiddenProviders={NO_HIDDEN_PROVIDERS}
              now={now}
            />
          </section>
        </div>
      </main>
    </SidebarInset>
  );
}
