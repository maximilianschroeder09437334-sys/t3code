import { useCallback, useEffect, useRef, useState } from "react";

export interface QuestionAnswerDraft {
  readonly defaultValue: string;
  readonly onChangeText: (value: string) => void;
  readonly onBlur: () => void;
  readonly flush: (nativeValue?: string) => void;
  /** Forgets local text after an outside write, such as an option selection, cleared the answer. */
  readonly clear: () => boolean;
}

/**
 * Keeps a custom answer's keystrokes in the native input and commits the text to shared draft
 * state only on blur, end of editing, submit, or unmount. Writing shared state per keystroke
 * re-renders the whole thread screen while the user types, which dropped and reordered letters.
 */
export function useQuestionAnswerDraft(
  initialValue: string,
  onCommit: (value: string) => void,
): QuestionAnswerDraft {
  const [defaultValue] = useState(initialValue);
  const valueRef = useRef(defaultValue);
  const committedValueRef = useRef(defaultValue);
  const onCommitRef = useRef(onCommit);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the latest commit callback for flushes from native events and unmount
  useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);

  const onChangeText = useCallback((value: string) => {
    valueRef.current = value;
  }, []);
  const flush = useCallback((nativeValue?: string) => {
    const value = nativeValue ?? valueRef.current;
    valueRef.current = value;
    if (value === committedValueRef.current) return;
    committedValueRef.current = value;
    onCommitRef.current(value);
  }, []);
  const onBlur = useCallback(() => flush(), [flush]);
  const clear = useCallback(() => {
    const hadText = valueRef.current !== "";
    valueRef.current = "";
    committedValueRef.current = "";
    return hadText;
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- commits the last typed text when the keyed answer field unmounts
  useEffect(
    () => () => {
      flush();
    },
    [flush],
  );

  return { defaultValue, onChangeText, onBlur, flush, clear };
}
