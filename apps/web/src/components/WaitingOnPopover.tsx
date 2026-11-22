import type {
  ResolvedThreadWait,
  ResolvedWaitTarget,
} from "@t3tools/client-runtime/state/thread-wait";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState, type ReactElement, type ReactNode, type SyntheticEvent } from "react";

import { cn } from "~/lib/utils";
import { useThreadWait } from "../state/threadWaits";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  openWaitTargets,
  waitTargetLabel,
  waitTargetRoute,
  waitTargetText,
  type WaitTargetRoute,
} from "./WaitingOn.logic";

export interface WaitingOnWaiter {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/**
 * Opens a wait target: its thread, a watched pull request in the pull request view, or the
 * waiter's timeline at the target's item.
 */
export function useOpenWaitTarget() {
  const navigate = useNavigate();
  return (route: WaitTargetRoute) => {
    if ("pullRequestUrl" in route) {
      void navigate({
        to: "/pull-requests",
        search: { involvement: "all", state: "all", selectedUrl: route.pullRequestUrl },
      });
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: route.environmentId, threadId: route.threadId },
      search: route.item === undefined ? {} : { item: route.item },
    });
  };
}

const stopPropagation = (event: SyntheticEvent) => event.stopPropagation();

/** "subagent Fix tests", "PR #12 checks", "command": the kind word muted, the title plain. */
export function WaitTargetName({ target }: { target: ResolvedWaitTarget }) {
  const { kind, title } = waitTargetLabel(target);
  return (
    <>
      {kind === null ? null : (
        <span className="text-muted-foreground">{title === null ? kind : `${kind} `}</span>
      )}
      {title === null ? null : <span className="text-foreground">{title}</span>}
    </>
  );
}

function WaitTargetSuffix({ target }: { target: ResolvedWaitTarget }) {
  if (target.suffix === undefined) return null;
  return (
    <span
      className={cn(
        "shrink-0",
        target.suffix === "needs you" ? "text-warning-foreground" : "text-muted-foreground",
      )}
    >
      · {target.suffix}
    </span>
  );
}

/** Open for one target; disabled with a reason while its environment is not connected. */
export function WaitTargetOpenButton(props: {
  waiter: WaitingOnWaiter;
  target: ResolvedWaitTarget;
  onOpened?: () => void;
  className?: string;
}) {
  const openTarget = useOpenWaitTarget();
  const route = waitTargetRoute(props.waiter, props.target);
  const button = (
    <Button
      size="xs"
      variant="ghost"
      className={props.className}
      disabled={route === null}
      aria-label={`Open ${waitTargetText(props.target)}`}
      onClick={(event) => {
        event.stopPropagation();
        if (route === null) return;
        props.onOpened?.();
        openTarget(route);
      }}
    >
      Open
    </Button>
  );
  if (route !== null) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>{button}</TooltipTrigger>
      <TooltipPopup side="top">Its environment is not connected</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The Waiting status as a trigger: clicking it lists "Waiting on <kind> <title>" with Open per
 * line.
 * Renders the trigger alone when nothing is open to list.
 */
export function WaitingOnPopover(props: {
  waiter: WaitingOnWaiter;
  wait: ResolvedThreadWait | undefined;
  /** The lines to list instead of the open targets, under `label`. */
  targets?: ReadonlyArray<ResolvedWaitTarget>;
  /** What each line says before its title; "Waiting on" unless given. */
  label?: string;
  trigger: ReactElement;
  children?: ReactNode;
  side?: "top" | "bottom";
  align?: "start" | "center" | "end";
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    props.onOpenChange?.(next);
  };
  const targets = props.targets ?? openWaitTargets(props.wait);
  const label = props.label ?? "Waiting on";
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={props.trigger}>{props.children}</PopoverTrigger>
      <PopoverPopup
        side={props.side ?? "bottom"}
        align={props.align ?? "end"}
        padding="compact"
        className="max-w-80"
        // The popup portals out of the DOM but not out of React, so a click on its text would
        // bubble to the row holding the trigger and open or rename that thread instead.
        // Keys still bubble: Escape closes the popover at the document.
        onClick={stopPropagation}
        onDoubleClick={stopPropagation}
        onContextMenu={stopPropagation}
      >
        {targets.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing left to wait on</p>
        ) : (
          <ul className="flex flex-col gap-0.5 text-xs" aria-label={label}>
            {targets.map((target, index) => (
              <li
                key={`${target.environmentId}:${target.threadId ?? target.itemId ?? target.taskId ?? index}`}
                className="flex min-w-0 items-center gap-2"
              >
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-muted-foreground">{label} </span>
                  <WaitTargetName target={target} />
                </span>
                <WaitTargetSuffix target={target} />
                <WaitTargetOpenButton
                  waiter={props.waiter}
                  target={target}
                  onOpened={() => onOpenChange(false)}
                />
              </li>
            ))}
          </ul>
        )}
      </PopoverPopup>
    </Popover>
  );
}

/** The thread header's Waiting pill; shown only while a target still runs. */
export function ThreadWaitingPill(props: { waiter: WaitingOnWaiter }) {
  const wait = useThreadWait(props.waiter.environmentId, props.waiter.threadId);
  if (wait?.waiting !== true) return null;
  return (
    <WaitingOnPopover
      waiter={props.waiter}
      wait={wait}
      align="start"
      trigger={
        <Badge
          variant="info"
          size="sm"
          render={<button type="button" aria-label="Show what this thread is waiting on" />}
        />
      }
    >
      Waiting
    </WaitingOnPopover>
  );
}
