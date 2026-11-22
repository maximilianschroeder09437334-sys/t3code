export interface HomeNotificationInput {
  readonly threadId: string;
  readonly runId: string | null;
  readonly isChild: boolean;
  readonly sideChat: boolean;
  readonly snoozed: boolean;
  readonly settled: boolean;
  readonly needsYou: boolean;
  readonly askText: string | null;
  readonly turnCompleted: boolean;
  readonly hasRunningChildren: boolean;
  readonly waiting: boolean;
  readonly hasAutoWait: boolean;
  readonly handedOff: boolean;
  readonly doneText: string | null;
}

export type HomeNotificationEvent =
  | { readonly kind: "needs"; readonly key: string; readonly text: string }
  | { readonly kind: "done"; readonly key: string; readonly text: string };

/** Server event policy shared by notification transports. */
export function classifyHomeNotification(
  input: HomeNotificationInput,
): HomeNotificationEvent | null {
  if (input.isChild || input.sideChat || input.snoozed || input.settled) return null;
  const runId = input.runId ?? "unknown";
  if (input.needsYou) {
    return {
      kind: "needs",
      key: `needs:${input.threadId}:${runId}:${input.askText ?? "request"}`,
      text: input.askText ?? "Needs you",
    };
  }
  if (
    !input.turnCompleted ||
    input.hasRunningChildren ||
    input.waiting ||
    input.hasAutoWait ||
    input.handedOff
  )
    return null;
  return {
    kind: "done",
    key: `done:${input.threadId}:${runId}`,
    text: input.doneText ?? "Task finished",
  };
}

export function isNewHomeNotification(
  previousKey: string | null,
  next: HomeNotificationEvent | null,
): next is HomeNotificationEvent {
  return next !== null && next.key !== previousKey;
}
