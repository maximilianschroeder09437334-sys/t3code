import { View } from "react-native";

import { cn } from "../../lib/cn";
import type { SubagentRowTone } from "./threadAgentsPresentation";

const TONE_CLASS = {
  working: "bg-foreground-muted",
  completed: "bg-adaptive-emerald-600-400",
  failed: "bg-danger-foreground",
  stopped: "bg-foreground-muted",
} as const satisfies Record<SubagentRowTone, string>;

export const SUBAGENT_TONE_TEXT_CLASS = {
  working: "text-foreground-muted",
  completed: "text-adaptive-emerald-600-400",
  failed: "text-danger-foreground",
  stopped: "text-foreground-muted",
} as const satisfies Record<SubagentRowTone, string>;

export function SubagentStatusDot({
  tone,
  placement = "inline",
}: {
  readonly tone: SubagentRowTone;
  readonly placement?: "inline" | "sheet";
}) {
  return (
    <View
      className={cn(
        "shrink-0 rounded-full",
        placement === "sheet" ? "h-2 w-2" : "h-1.5 w-1.5",
        TONE_CLASS[tone],
      )}
    />
  );
}
