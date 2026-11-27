import {
  EnvironmentId,
  NodeId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { makeThreadRequestsResolvedAnnouncer } from "@t3tools/client-runtime/state/thread-requests";
import type { Editor } from "@tiptap/core";
import { useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

vi.mock(import("../ChatMarkdown"), async (importOriginal) => ({
  ...(await importOriginal()),
  default: (({ text }: { text: string }) => <p>{text}</p>) as never,
}));

import { act, fakeTimers, render } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { serializeEditorDoc } from "../../composer-rich-text-doc";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { toastManager } from "../ui/toast";
import {
  ComposerPromptEditorTiptap,
  type ComposerPromptEditorHandle,
} from "../ComposerPromptEditorTiptap";
import { usePendingThreadRequests, usePendingUserInputDraft } from "./usePendingThreadRequests";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

const prompt = {
  requestId: RuntimeRequestId.make("question-navigation"),
  createdAt: "2026-10-09T00:00:00.000Z",
  dismissible: false,
  responseCapability: "live" as const,
  questions: [0, 1, 2].map((index) => ({
    id: `question-${index}`,
    header: `Question ${index + 1}`,
    question: `Choose for question ${index + 1}`,
    options: [{ label: "Incremental", description: "One module at a time" }],
    multiSelect: false,
  })),
};

function questionProjection(threadId: ThreadId, requestIds = ["first", "second"]) {
  const projection = makeThreadProjectionFixture();
  return {
    ...projection,
    thread: { ...projection.thread, id: threadId },
    runtimeRequests: requestIds.map((id) => ({
      id: RuntimeRequestId.make(id),
      nodeId: NodeId.make(id),
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input" as const,
      status: "pending" as const,
      responseCapability: { type: "message" as const },
      createdAt: projection.updatedAt,
      resolvedAt: null,
    })),
    turnItems: requestIds.map((id, ordinal) => ({
      id: TurnItemId.make(id),
      threadId,
      runId: null,
      nodeId: NodeId.make(id),
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed" as const,
      title: null,
      startedAt: projection.updatedAt,
      completedAt: projection.updatedAt,
      updatedAt: projection.updatedAt,
      type: "user_input_request" as const,
      requestId: RuntimeRequestId.make(id),
      questions: prompt.questions,
    })),
  } satisfies OrchestrationV2ThreadProjection;
}

interface ProbeProps {
  environmentId: EnvironmentId;
  projection: OrchestrationV2ThreadProjection;
  loading?: boolean;
  draftTarget?: DraftId;
}

function useProbeRequests({ environmentId, projection, loading = false, draftTarget }: ProbeProps) {
  const promptRef = useRef("");
  const composerRef = useRef(null);
  const requests = usePendingThreadRequests({
    environmentId,
    activeThreadId: projection.thread.id,
    serverProjection: loading ? null : projection,
    supportsQuestionAttachments: false,
    composerDraftTarget: draftTarget ?? { environmentId, threadId: projection.thread.id },
    setComposerDraftPrompt: (target, prompt) =>
      useComposerDraftStore.getState().setPrompt(target, prompt),
    promptRef,
    composerRef,
    setThreadError: () => {},
  });
  const draft = usePendingUserInputDraft({
    environmentId,
    activeThreadId: projection.thread.id,
    activePendingUserInput: requests.activePendingUserInput,
    supportsQuestionAttachments: false,
  });
  return { ...requests, ...draft };
}

let requests: ReturnType<typeof useProbeRequests>;

function PendingRequestsProbe(props: ProbeProps) {
  const state = useProbeRequests(props);
  useLayoutEffect(() => {
    requests = state;
  });
  return null;
}

it("retains answers, selections and question position after leaving chat, including while the projection reloads", async () => {
  using _timers = fakeTimers();
  const environmentId = EnvironmentId.make("remount-environment");
  const projection = questionProjection(threadRef.threadId);
  const probe = (loading = false) => (
    <PendingRequestsProbe environmentId={environmentId} projection={projection} loading={loading} />
  );
  await using screen = await render(probe());
  await act(() =>
    requests.onChangeActivePendingUserInputCustomAnswer("question-0", "Keep my text"),
  );
  await act(() => requests.onAdvanceActivePendingUserInput());
  await act(() => requests.onSelectActivePendingUserInputOption("question-1", "Incremental"));
  await act(() => requests.onAdvanceActivePendingUserInput());
  const expected = {
    activePendingQuestionIndex: 2,
    activePendingDraftAnswers: {
      "question-0": { customAnswer: "Keep my text" },
      "question-1": { selectedOptionValues: ["Incremental"] },
    },
  };
  expect(requests).toMatchObject(expected);

  // New thread and Settings both unmount the chat that owns this hook.
  await screen.rerender(null);
  await screen.rerender(probe());
  expect(requests).toMatchObject(expected);

  await screen.rerender(null);
  await screen.rerender(probe(true));
  expect(requests.activePendingUserInput).toBeNull();
  await screen.rerender(probe());
  expect(requests).toMatchObject(expected);
});

it("tells the user when an option click moves their typed answer into the hidden composer draft", async () => {
  using _timers = fakeTimers();
  const environmentId = EnvironmentId.make("displaced-environment");
  const draftTarget = { environmentId, threadId: threadRef.threadId };
  const draftPrompt = () => useComposerDraftStore.getState().getComposerDraft(draftTarget)?.prompt;
  using toast = vi.spyOn(toastManager, "add");
  const probe = (threadId: ThreadId) => (
    <PendingRequestsProbe environmentId={environmentId} projection={questionProjection(threadId)} />
  );
  await using screen = await render(probe(threadRef.threadId));

  await act(() => requests.onSelectActivePendingUserInputOption("question-0", "Incremental"));
  expect(toast).not.toHaveBeenCalled();

  await act(() => requests.onChangeActivePendingUserInputCustomAnswer("question-0", "first try"));
  await act(() => requests.onSelectActivePendingUserInputOption("question-0", "Incremental"));
  expect(draftPrompt()).toBe("first try");
  expect(toast).toHaveBeenCalledTimes(1);
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "info",
      title: "Your typed text was set aside",
      description: "It will be back in the composer once the question is answered.",
      data: { threadRef: draftTarget },
    }),
  );

  await act(() => requests.onChangeActivePendingUserInputCustomAnswer("question-0", "second try"));
  expect(draftPrompt()).toBe("first try");
  expect(requests.activePendingDraftAnswers["question-0"]).toMatchObject({
    customAnswer: "second try",
  });
  expect(toast).toHaveBeenCalledTimes(1);

  // The hook outlives a thread switch; text set aside in another thread is in another draft.
  await screen.rerender(probe(ThreadId.make("other-thread")));
  await act(() => requests.onChangeActivePendingUserInputCustomAnswer("question-0", "elsewhere"));
  await act(() => requests.onSelectActivePendingUserInputOption("question-0", "Incremental"));
  await screen.rerender(probe(threadRef.threadId));

  // regression: #35205 undo puts the set-aside text back, so the draft must not keep a copy to resend
  await act(() => requests.onChangeActivePendingUserInputCustomAnswer("question-0", "first try"));
  expect(draftPrompt() ?? "").toBe("");

  // Text set aside into a queued-message edit draft never withdraws from the thread draft.
  await screen.rerender(
    <PendingRequestsProbe
      environmentId={environmentId}
      projection={questionProjection(threadRef.threadId)}
      draftTarget={DraftId.make("queued-edit")}
    />,
  );
  await act(() => requests.onChangeActivePendingUserInputCustomAnswer("question-0", "foo"));
  await act(() => requests.onSelectActivePendingUserInputOption("question-0", "Incremental"));
  await screen.rerender(probe(threadRef.threadId));
  useComposerDraftStore.getState().setPrompt(draftTarget, "foo");
  await act(() => requests.onChangeActivePendingUserInputCustomAnswer("question-0", "foo"));
  expect(draftPrompt()).toBe("foo");
});

function QuestionPositionProbe(props: ProbeProps) {
  const state = useProbeRequests(props);
  return (
    <>
      <output>Question {state.activePendingQuestionIndex + 1}</output>
      <button
        type="button"
        onClick={() => state.onSelectActivePendingUserInputOption("question-0", "Incremental")}
      >
        Choose Incremental
      </button>
      <button type="button" onClick={() => state.onAdvanceActivePendingUserInput()}>
        Submit
      </button>
    </>
  );
}

it("stays on an unanswered question when the composer submits", async () => {
  await using screen = await render(
    <QuestionPositionProbe
      environmentId={EnvironmentId.make("unanswered-environment")}
      projection={questionProjection(threadRef.threadId)}
    />,
  );
  const submit = screen.getByRole("button", { name: "Submit" });
  await userEvent.click(submit);
  await expect.element(screen.getByRole("status")).toHaveTextContent("Question 1");

  await userEvent.click(screen.getByRole("button", { name: "Choose Incremental" }));
  await userEvent.click(submit);
  await expect.element(screen.getByRole("status")).toHaveTextContent("Question 2");
});

/** Wires the composer editor to the answer draft the way ChatComposer does. */
function AnswerEditorProbe(props: ProbeProps) {
  const state = useProbeRequests(props);
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const answer = state.activePendingProgress?.customAnswer ?? "";
  const [cursor, setCursor] = useState(answer.length);
  useLayoutEffect(() => {
    requests = state;
  });
  return (
    <ComposerPromptEditorTiptap
      editorRef={editorRef}
      ariaLabel="Answer"
      value={answer}
      cursor={cursor}
      contextRecords={new Map()}
      skills={[]}
      disabled={false}
      placeholder=""
      onPaste={() => {}}
      onChange={(value, nextCursor) => {
        setCursor(nextCursor);
        state.onChangeActivePendingUserInputCustomAnswer("question-0", value);
      }}
    />
  );
}

it("keeps every letter in order when an answer is typed faster than the draft renders", async () => {
  await using screen = await render(
    <AnswerEditorProbe
      environmentId={EnvironmentId.make("fast-typing-environment")}
      projection={questionProjection(threadRef.threadId)}
    />,
  );
  const element = screen.container.querySelector<HTMLElement & { editor: Editor }>(".tiptap");
  if (!element) throw new Error("Answer editor did not mount");
  const { editor } = element;
  const typed = "The quick brown fox jumps over the lazy dog, twice. ".repeat(4);
  await userEvent.click(element);
  await userEvent.keyboard(typed);
  await vi.waitFor(() => expect(requests.activePendingProgress?.customAnswer).toBe(typed));
  expect(serializeEditorDoc(editor.state.doc).value).toBe(typed);

  // Several keystrokes land before the draft store renders once.
  const burst = "abcdefghijklmnopqrstuvwxyz0123456789";
  await act(() => {
    for (const letter of burst) {
      editor.view.dispatch(editor.view.state.tr.insertText(letter));
    }
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe(typed + burst);
  expect(requests.activePendingProgress?.customAnswer).toBe(typed + burst);

  // The next keystrokes continue at the end, so no render moved the caret back.
  await userEvent.keyboard(" end");
  await vi.waitFor(() =>
    expect(requests.activePendingProgress?.customAnswer).toBe(`${typed}${burst} end`),
  );
  expect(serializeEditorDoc(editor.state.doc).value).toBe(`${typed}${burst} end`);
});

it("isolates drafts by environment, thread and request and discards only resolved requests", async () => {
  using _timers = fakeTimers();
  const environmentId = EnvironmentId.make("scope-environment");
  const projection = questionProjection(threadRef.threadId);
  const scopes = [
    { environmentId, projection },
    { environmentId: EnvironmentId.make("other-environment"), projection },
    { environmentId, projection: questionProjection(ThreadId.make("other-thread")) },
    { environmentId, projection: questionProjection(threadRef.threadId, ["second", "first"]) },
  ];
  await using screen = await render(null);
  const show = (scope: ComponentProps<typeof PendingRequestsProbe>) =>
    screen.rerender(<PendingRequestsProbe {...scope} />);
  for (const [index, scope] of scopes.entries()) {
    await show(scope);
    expect(requests.activePendingQuestionIndex).toBe(0);
    expect(requests.activePendingDraftAnswers["question-0"]?.customAnswer).toBeUndefined();
    await act(() =>
      requests.onChangeActivePendingUserInputCustomAnswer("question-0", `Answer ${index}`),
    );
    await act(() => requests.onAdvanceActivePendingUserInput());
  }

  // "first" was answered on another device.
  await show({
    environmentId,
    projection: {
      ...projection,
      runtimeRequests: projection.runtimeRequests.map((request) =>
        request.id === "first"
          ? { ...request, status: "resolved", resolvedAt: projection.updatedAt }
          : request,
      ),
    },
  });
  expect(requests.activePendingUserInput?.requestId).toBe("second");
  await act(() =>
    makeThreadRequestsResolvedAnnouncer(
      environmentId,
      threadRef.threadId,
    )([
      { id: RuntimeRequestId.make("first"), status: "resolved" },
      { id: RuntimeRequestId.make("second"), status: "pending" },
    ]),
  );
  for (const [index, scope] of scopes.entries()) {
    await show(scope);
    expect(requests.activePendingQuestionIndex).toBe(index === 0 ? 0 : 1);
    expect(requests.activePendingDraftAnswers["question-0"]?.customAnswer).toBe(
      index === 0 ? undefined : `Answer ${index}`,
    );
  }
});
