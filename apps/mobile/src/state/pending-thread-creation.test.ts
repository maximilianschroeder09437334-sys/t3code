import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import { describe, expect, it } from "vite-plus/test";

import {
  pendingThreadCreationShell,
  resolvePendingThreadCreation,
  selectThreadCreationDetail,
  threadCreationSettlement,
  withLaunchingThreads,
  type PendingThreadCreation,
} from "./pending-thread-creation";
import type { QueuedThreadMessage } from "./thread-outbox-model";

const creation: QueuedThreadMessage = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  messageId: MessageId.make("message-1"),
  commandId: CommandId.make("command-1"),
  text: "Fix the flaky login test",
  attachments: [
    {
      id: "draft-image",
      type: "image",
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 10,
      previewUri: "data:image/png;base64,AAAA",
    },
  ],
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
  runtimeMode: "full-access",
  creation: {
    projectId: ProjectId.make("project-1"),
    workspaceMode: "worktree",
    branch: "main",
    worktreePath: null,
  },
  createdAt: "2026-08-24T12:00:00.000Z",
};

describe("resolvePendingThreadCreation", () => {
  const threadKey = `${creation.environmentId}:${creation.threadId}`;
  const pending: PendingThreadCreation = { message: creation, outcome: null };
  const prompt = { id: creation.messageId };

  it("keeps setup visible through the prompt echo and shell cleanup until detail has a turn", () => {
    let previous = resolvePendingThreadCreation({
      threadKey,
      pending,
      previous: null,
      detail: null,
    });
    expect(previous).toBe(pending);

    previous = resolvePendingThreadCreation({
      threadKey,
      pending,
      previous,
      detail: { messages: [], runs: [] },
    });
    expect(previous).toBe(pending);

    previous = resolvePendingThreadCreation({
      threadKey,
      pending,
      previous,
      detail: { messages: [prompt], runs: [] },
    });
    expect(previous).toBe(pending);

    previous = resolvePendingThreadCreation({
      threadKey,
      pending: null,
      previous,
      detail: { messages: [prompt], runs: [] },
    });
    expect(previous).toBe(pending);

    expect(
      resolvePendingThreadCreation({
        threadKey,
        pending: null,
        previous,
        detail: {
          messages: [prompt],
          runs: [{ status: "running" }],
        },
      }),
    ).toBeNull();
  });

  it("keeps the prompt until both the turn and its message have arrived", () => {
    expect(
      resolvePendingThreadCreation({
        threadKey,
        pending,
        previous: null,
        detail: { messages: [], runs: [{ status: "running" }] },
      }),
    ).toBe(pending);
  });

  it("preserves rejected task recovery", () => {
    const failed: PendingThreadCreation = {
      message: creation,
      outcome: { kind: "failed", message: creation, reason: "Checkout failed" },
    };
    expect(
      resolvePendingThreadCreation({
        threadKey,
        pending: failed,
        previous: pending,
        detail: { messages: [], runs: [] },
      }),
    ).toBe(failed);
  });

  it("does not carry setup into another thread or invent it for existing threads", () => {
    expect(
      resolvePendingThreadCreation({
        threadKey: "another-thread",
        pending: null,
        previous: pending,
        detail: null,
      }),
    ).toBeNull();
    expect(
      resolvePendingThreadCreation({
        threadKey,
        pending: null,
        previous: null,
        detail: null,
      }),
    ).toBeNull();
  });
});

describe("selectThreadCreationDetail", () => {
  const threadKey = `${creation.environmentId}:${creation.threadId}`;
  const threadRef = { environmentId: creation.environmentId, threadId: creation.threadId };

  it("withholds the detail ref until the creation is delivered", () => {
    const queued = selectThreadCreationDetail({
      threadRef,
      threadKey,
      queuedMessagesByThreadKey: { [threadKey]: [creation] },
      outcomes: {},
    });
    expect(queued).toEqual({
      pendingCreation: { message: creation, outcome: null },
      detailRef: null,
    });

    const failed = selectThreadCreationDetail({
      threadRef,
      threadKey,
      queuedMessagesByThreadKey: {},
      outcomes: { [threadKey]: { kind: "failed", message: creation, reason: "Checkout failed" } },
    });
    expect(failed.pendingCreation?.outcome?.kind).toBe("failed");
    expect(failed.detailRef).toBeNull();

    const delivered = selectThreadCreationDetail({
      threadRef,
      threadKey,
      queuedMessagesByThreadKey: {},
      outcomes: { [threadKey]: { kind: "delivered", message: creation } },
    });
    expect(delivered.pendingCreation?.outcome?.kind).toBe("delivered");
    expect(delivered.detailRef).toBe(threadRef);
  });

  it("does not hold back existing threads with only follow-ups queued", () => {
    const { creation: _creation, ...followUp } = creation;
    expect(
      selectThreadCreationDetail({
        threadRef,
        threadKey,
        queuedMessagesByThreadKey: { [threadKey]: [followUp] },
        outcomes: {},
      }),
    ).toEqual({ pendingCreation: null, detailRef: threadRef });
  });
});

describe("withLaunchingThreads", () => {
  it("reads as working from Send until the thread's first run arrives", () => {
    const launch = (threads: Parameters<typeof withLaunchingThreads>[0]["threads"]) =>
      withLaunchingThreads({ threads, launches: [creation], hiddenThreadKeys: new Set() });
    // Before the shell arrives, and after the server commits the thread without its run.
    const created = { ...pendingThreadCreationShell(creation)!, title: "Server title" };
    for (const threads of [launch([]), launch([created])]) {
      expect(threads).toHaveLength(1);
      expect(isThreadWorking(threads[0]!)).toBe(true);
    }
    expect(launch([created])[0]!.title).toBe("Server title");

    const started = {
      ...created,
      latestRun: {
        runId: RunId.make("run-1"),
        status: "completed" as const,
        requestedAt: null,
        startedAt: null,
        completedAt: null,
        assistantMessageId: null,
      },
    };
    expect(launch([started])[0]).toBe(started);
  });
});

describe("threadCreationSettlement", () => {
  const threadKey = `${creation.environmentId}:${creation.threadId}`;
  const settle = (
    input: Partial<Omit<Parameters<typeof threadCreationSettlement>[0], "message">>,
  ) =>
    threadCreationSettlement({
      message: creation,
      queuedMessagesByThreadKey: {},
      outcomes: {},
      shellExists: false,
      restoredDraftHasContent: false,
      ...input,
    });

  it("waits while the creation is queued, even once its shell arrives early", () => {
    expect(settle({ queuedMessagesByThreadKey: { [threadKey]: [creation] } })).toBeNull();
    expect(
      settle({ queuedMessagesByThreadKey: { [threadKey]: [creation] }, shellExists: true }),
    ).toBeNull();
  });

  it("settles on the server's acknowledgement or rejection", () => {
    const delivered = { kind: "delivered", message: creation } as const;
    const failed = { kind: "failed", message: creation, reason: "Rejected" } as const;
    expect(
      settle({
        queuedMessagesByThreadKey: { [threadKey]: [creation] },
        outcomes: { [threadKey]: delivered },
      }),
    ).toBe(delivered);
    expect(settle({ outcomes: { [threadKey]: failed } })).toBe(failed);
  });

  it("ignores an outcome left by an earlier send to the same thread", () => {
    const earlier = { ...creation, messageId: MessageId.make("message-0") };
    expect(
      settle({
        queuedMessagesByThreadKey: { [threadKey]: [creation] },
        outcomes: { [threadKey]: { kind: "failed", message: earlier, reason: "Rejected" } },
      }),
    ).toBeNull();
  });

  it("reads an unqueued creation whose shell exists as delivered", () => {
    expect(settle({ shellExists: true })).toEqual({ kind: "delivered", message: creation });
  });

  it("waits for a rejection being recorded, and reads anything else unqueued as dropped", () => {
    expect(settle({ restoredDraftHasContent: true })).toBeNull();
    expect(settle({})).toEqual({ kind: "dropped" });
  });
});
