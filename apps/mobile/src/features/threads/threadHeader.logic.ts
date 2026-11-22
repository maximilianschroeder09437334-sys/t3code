export type MobileSurfaceId =
  | "browser"
  | "terminal"
  | "files"
  | "diff"
  | "pull-request"
  | "linked-pull-requests"
  | "device"
  | "side-chat";

export interface MobileSurfaceItem {
  readonly id: MobileSurfaceId;
  readonly label: string;
  readonly available: boolean;
  readonly reason?: string;
}

export function formatContextUsage(usedTokens: number, maxTokens: number | null): string {
  const format = (value: number) =>
    value >= 1_000_000
      ? `${Number((value / 1_000_000).toFixed(1))}m`
      : value >= 1_000
        ? `${Math.round(value / 1_000)}k`
        : String(value);
  return `${format(usedTokens)} / ${maxTokens === null ? "unknown" : format(maxTokens)}`;
}

export function mobileThreadSurfaces(input: {
  readonly canOpenTerminal: boolean;
  readonly canOpenFiles: boolean;
  readonly isGitRepo: boolean;
  readonly hasPullRequest: boolean;
  readonly hasSideChat: boolean;
}): ReadonlyArray<MobileSurfaceItem> {
  return [
    { id: "browser", label: "Browser", available: false, reason: "Not on mobile yet" },
    {
      id: "terminal",
      label: "Terminal",
      available: input.canOpenTerminal,
      reason: "Unavailable for this thread",
    },
    {
      id: "files",
      label: "Files",
      available: input.canOpenFiles,
      reason: "Unavailable for this thread",
    },
    {
      id: "diff",
      label: "Diff",
      available: input.isGitRepo,
      reason: "Unavailable for this thread",
    },
    {
      id: "pull-request",
      label: "Pull request",
      available: input.hasPullRequest,
      reason: "Unavailable for this thread",
    },
    {
      id: "linked-pull-requests",
      label: "Linked pull requests",
      available: false,
      reason: "Not on mobile yet",
    },
    { id: "device", label: "Device", available: false, reason: "Not available for this thread" },
    {
      id: "side-chat",
      label: "Side chat",
      available: input.hasSideChat,
      reason: input.hasSideChat ? undefined : "No side chats for this thread",
    },
  ];
}
