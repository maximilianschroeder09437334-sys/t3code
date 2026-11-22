import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  enqueue: vi.fn<(message: unknown) => Promise<void>>(),
  alert: vi.fn(),
  clearDraft: vi.fn(),
  updateFlow: vi.fn(),
  sendMessage: null as null | (() => Promise<string | null>),
  draft: { text: "Fix the build", attachments: [], context: undefined },
  message: {
    environmentId: "env-1",
    threadId: "thread-from-home",
    messageId: "message-from-home",
  },
}));

const project = {
  environmentId: "env-1",
  id: "project-1",
  title: "Project",
  workspaceRoot: "/repo",
  archivedAt: null,
};
const flow = {
  selectedProject: project,
  selectedEnvironmentId: "env-1",
  draftKey: "home-draft",
  submitting: false,
  environments: [{ environmentId: "env-1", environmentLabel: "Desktop" }],
  selectedModel: { instanceId: "codex", model: "gpt" },
  linkedEnvironments: new Map(),
  currentCheckoutBranchName: "main",
  runtimeMode: "full-access",
  selectedBranchName: "main",
  selectedWorktreePath: null,
  workspaceCwd: "/repo",
  workspaceMode: "local",
  isGitRepoKnown: true,
  resolveWorkspaceSelection: () => ({ mode: "local" }),
  buildPendingTaskMessage: () => harness.message,
  setSubmitting: () => undefined,
  setProject: () => undefined,
  setPrompt: () => undefined,
  removeAttachment: () => undefined,
};

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({}) }));
vi.mock("react-native", () => ({
  Dimensions: { get: () => ({ height: 800 }) },
  Platform: { OS: "ios" },
  Pressable: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardStickyView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-reanimated", () => ({ useSharedValue: (value: number) => ({ value }) }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: harness.alert }));
vi.mock("../../components/ui/Menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../../lib/commandMetadata", () => ({
  makeTurnCommandMetadata: () => ({
    commandId: "command-1",
    messageId: "message-1",
    threadId: "thread-1",
    createdAt: "2026-11-22T00:00:00.000Z",
  }),
}));
vi.mock("../../lib/composerContext", () => ({ composerContextSendBlockReason: () => null }));
vi.mock("../../lib/modelOptions", () => ({
  describeUnavailableModelSelection: () => ({ title: "", detail: "" }),
  isModelSelectionUnavailable: () => false,
  resolveSelectableModelSelection: () => null,
}));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: { get: () => ({}) } }));
vi.mock("../../state/composer-attachment-uploads", () => ({
  composerAttachmentUploadBlockReason: () => null,
  composerAttachmentsStillUploading: () => false,
  composerAttachmentUploadsAtom: {},
}));
vi.mock("../../state/composerDraftOperations", () => ({
  abortComposerDraftOperations: () => undefined,
}));
vi.mock("../../state/entities", () => ({ useEnvironmentServerConfig: () => null }));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock("../../state/thread-outbox", () => ({ enqueueThreadOutboxMessage: harness.enqueue }));
vi.mock("../../state/use-composer-attachment-actions", () => ({
  useComposerAttachmentActions: () => ({}),
}));
vi.mock("../../state/use-composer-drafts", () => ({
  clearComposerDraftContent: harness.clearDraft,
  composerContextImportsAtom: {},
  getComposerDraftSnapshot: () => harness.draft,
  scheduleUnusedComposerAttachmentCleanup: () => undefined,
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteEnvironmentRuntime: () => ({ connectionState: "connected" }),
}));
vi.mock("../threads/ComposerPopoverHost", () => ({
  ComposerPopoverHost: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../threads/draft-thread-shell", () => ({ draftThreadShell: () => ({}) }));
vi.mock("../threads/new-task-flow-provider", () => ({ useNewTaskFlow: () => flow }));
vi.mock("../threads/new-task-flow-state", () => ({
  HOME_COMPOSER_FLOW_KEY: "home",
  updateNewTaskFlowState: harness.updateFlow,
}));
vi.mock("../threads/ThreadComposer", () => ({
  ThreadComposer: (props: { onSendMessage: () => Promise<string | null> }) => {
    harness.sendMessage = props.onSendMessage;
    return <p>composer</p>;
  },
}));

import { HomeComposer } from "./HomeComposer";

afterEach(() => {
  vi.clearAllMocks();
  harness.sendMessage = null;
});

function renderHomeComposer(onThreadStarted: (thread: unknown) => void) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  act(() =>
    root.render(
      <HomeComposer
        projects={[project] as never}
        onThreadStarted={onThreadStarted as never}
        onHeightChange={() => undefined}
      />,
    ),
  );
  return { [Symbol.dispose]: () => act(() => root.unmount()) };
}

it("the send button opens the thread it queued and clears only the sent draft", async () => {
  harness.enqueue.mockResolvedValue(undefined);
  const onThreadStarted = vi.fn();
  using _root = renderHomeComposer(onThreadStarted);

  let sent: string | null = null;
  await act(async () => {
    sent = await harness.sendMessage!();
  });

  expect(sent).toBe("message-from-home");
  // One queued thread, opened by the id the outbox creates it with.
  expect(harness.enqueue).toHaveBeenCalledTimes(1);
  expect(harness.enqueue).toHaveBeenCalledWith(harness.message);
  expect(onThreadStarted).toHaveBeenCalledTimes(1);
  expect(onThreadStarted).toHaveBeenCalledWith({
    environmentId: "env-1",
    threadId: "thread-from-home",
  });
  // Other drafts and recovery copies are never touched.
  expect(harness.clearDraft).toHaveBeenCalledTimes(1);
  expect(harness.clearDraft).toHaveBeenCalledWith("home-draft", expect.anything());
  expect(harness.updateFlow).toHaveBeenCalledWith("home", { draftKey: null });
});

it("stays on Home and keeps the draft when the thread could not be queued", async () => {
  harness.enqueue.mockRejectedValue(new Error("Outbox unavailable"));
  const onThreadStarted = vi.fn();
  using _root = renderHomeComposer(onThreadStarted);

  let sent: string | null = "unset";
  await act(async () => {
    sent = await harness.sendMessage!();
  });

  expect(sent).toBeNull();
  expect(harness.alert).toHaveBeenCalledWith("Could not start thread", "Outbox unavailable");
  expect(onThreadStarted).not.toHaveBeenCalled();
  expect(harness.clearDraft).not.toHaveBeenCalled();
  expect(harness.updateFlow).not.toHaveBeenCalled();
});

it("a send that finishes after leaving Home clears its draft but opens nothing", async () => {
  let finishEnqueue: () => void = () => undefined;
  harness.enqueue.mockReturnValue(
    new Promise<void>((resolve) => {
      finishEnqueue = resolve;
    }),
  );
  const onThreadStarted = vi.fn();
  const root = renderHomeComposer(onThreadStarted);

  let sending: Promise<string | null> = Promise.resolve(null);
  act(() => {
    sending = harness.sendMessage!();
  });
  root[Symbol.dispose]();
  await act(async () => {
    finishEnqueue();
    await sending;
  });

  expect(harness.enqueue).toHaveBeenCalledTimes(1);
  expect(onThreadStarted).not.toHaveBeenCalled();
  expect(harness.clearDraft).toHaveBeenCalledWith("home-draft", expect.anything());
});
