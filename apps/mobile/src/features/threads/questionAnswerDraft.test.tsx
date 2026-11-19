import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { useQuestionAnswerDraft, type QuestionAnswerDraft } from "./questionAnswerDraft";

function Harness(props: {
  readonly onCommit: (value: string) => void;
  readonly onDraft: (draft: QuestionAnswerDraft) => void;
  readonly onSubmit?: () => void;
}) {
  const draft = useQuestionAnswerDraft("", props.onCommit);
  props.onDraft(draft);
  return (
    <>
      <button
        onClick={() => {
          draft.flush();
          props.onSubmit?.();
        }}
      >
        Submit
      </button>
      <button onClick={draft.onBlur}>Blur</button>
    </>
  );
}

it("keeps rapid IME composition updates local until submit and commits the exact text", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const order: string[] = [];
  const onCommit = vi.fn((value: string) => order.push(`commit:${value}`));
  const onSubmit = vi.fn(() => order.push("submit"));
  let activeDraft!: QuestionAnswerDraft;
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <Harness
          onCommit={onCommit}
          onSubmit={onSubmit}
          onDraft={(draft) => (activeDraft = draft)}
        />,
      ),
    );
    await act(async () => {
      const rapidText = `${"n".repeat(128)}i\u4F60\u597D\u5417 \u{1F469}\u200D\u{1F4BB}`;
      for (let index = 1; index <= rapidText.length; index += 1) {
        activeDraft.onChangeText(rapidText.slice(0, index));
      }
    });
    expect(onCommit).not.toHaveBeenCalled();
    await act(async () => container.querySelector("button")?.click());
    const expected = `${"n".repeat(128)}i\u4F60\u597D\u5417 \u{1F469}\u200D\u{1F4BB}`;
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(expected);
    expect(order).toEqual([`commit:${expected}`, "submit"]);
  } finally {
    await act(async () => root.unmount());
  }
});

it("flushes once on blur even if unmount follows", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const onCommit = vi.fn();
  let activeDraft!: QuestionAnswerDraft;
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () =>
      root.render(<Harness onCommit={onCommit} onDraft={(draft) => (activeDraft = draft)} />),
    );
    await act(async () => activeDraft.onChangeText("answer before blur"));
    await act(async () => activeDraft.onBlur());
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("answer before blur");
  } finally {
    await act(async () => root.unmount());
  }
  expect(onCommit).toHaveBeenCalledExactlyOnceWith("answer before blur");
});

it("uses the native end-editing text when an IME commits its composition", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const onCommit = vi.fn();
  let activeDraft!: QuestionAnswerDraft;
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () =>
      root.render(<Harness onCommit={onCommit} onDraft={(draft) => (activeDraft = draft)} />),
    );
    await act(async () => activeDraft.onChangeText("ni"));
    await act(async () => activeDraft.flush("\u4F60"));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("\u4F60");
  } finally {
    await act(async () => root.unmount());
  }
});

it("commits a question's latest answer when its keyed field unmounts", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const onCommit = vi.fn();
  let activeDraft!: QuestionAnswerDraft;
  const onDraft = (draft: QuestionAnswerDraft) => (activeDraft = draft);
  function KeyedHarness(props: { readonly questionId: string }) {
    const draft = useQuestionAnswerDraft("", (value) => onCommit(props.questionId, value));
    onDraft(draft);
    return <button onClick={() => draft.flush()}>{props.questionId}</button>;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<KeyedHarness key="first" questionId="first" />));
    await act(async () => activeDraft.onChangeText("kept answer"));
    await act(async () => root.render(<KeyedHarness key="second" questionId="second" />));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("first", "kept answer");
  } finally {
    await act(async () => root.unmount());
  }
});

it("does not re-commit text an option selection cleared", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const onCommit = vi.fn();
  let activeDraft!: QuestionAnswerDraft;
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () =>
      root.render(<Harness onCommit={onCommit} onDraft={(draft) => (activeDraft = draft)} />),
    );
    await act(async () => activeDraft.onChangeText("typed before picking"));
    expect(activeDraft.clear()).toBe(true);
    expect(activeDraft.clear()).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
  expect(onCommit).not.toHaveBeenCalled();
});
