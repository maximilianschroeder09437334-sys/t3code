import { create } from "zustand";

/** The thread whose notes dialog is open; that thread's composer renders it. */
export const useThreadNotesStore = create<{ readonly threadKey: string | null }>()(() => ({
  threadKey: null,
}));

export function setOpenThreadNotes(threadKey: string | null): void {
  useThreadNotesStore.setState({ threadKey });
}
