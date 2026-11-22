import { CircleDotDashedIcon, type LucideProps } from "lucide-react";

import { cn } from "~/lib/utils";

/** The Waiting colour everywhere: sidebar, thread header and Home. */
export const WAITING_STATUS_CLASS_NAME = "text-info-foreground";

/** The Waiting icon everywhere: a dashed circle around a dot. */
export function WaitingStatusIcon({ className, ...props }: LucideProps) {
  return (
    <CircleDotDashedIcon
      aria-hidden
      data-waiting-status-icon=""
      className={cn("shrink-0", className)}
      {...props}
    />
  );
}
