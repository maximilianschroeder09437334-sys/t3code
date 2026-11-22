import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ResolvedThreadWait } from "@t3tools/client-runtime/state/thread-wait";

import { openWaitTargets } from "../WaitingOn.logic";
import { WaitingOnPopover, WaitTargetOpenButton } from "../WaitingOnPopover";

/** "Waiting on: <first> [Open] +N"; +N lists every open target. */
export function HomeWaitingOnLine(props: {
  thread: EnvironmentThreadShell;
  wait: ResolvedThreadWait;
}) {
  const targets = openWaitTargets(props.wait);
  const first = targets[0];
  if (first === undefined) return null;
  const waiter = { environmentId: props.thread.environmentId, threadId: props.thread.id };
  const more = targets.length - 1;
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1 text-xs text-muted-foreground">
      <span className="min-w-0 truncate">
        Waiting on: <span className="text-foreground">{first.title}</span>
        {first.suffix === undefined ? null : (
          <span className={first.suffix === "needs you" ? "text-warning-foreground" : undefined}>
            {" "}
            · {first.suffix}
          </span>
        )}
      </span>
      <WaitTargetOpenButton waiter={waiter} target={first} className="shrink-0" />
      {more > 0 ? (
        <WaitingOnPopover
          waiter={waiter}
          wait={props.wait}
          align="start"
          trigger={
            <button
              type="button"
              aria-label={`Show all ${targets.length} threads this is waiting on`}
              className="shrink-0 rounded-sm px-1 tabular-nums hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            />
          }
        >
          +{more}
        </WaitingOnPopover>
      ) : null}
    </span>
  );
}
