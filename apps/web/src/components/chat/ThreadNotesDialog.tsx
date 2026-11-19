import { useAtomValue } from "@effect/atom-react";
import { WS_METHODS, type ScopedThreadRef } from "@t3tools/contracts";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { connectionAtomRuntime } from "../../connection/runtime";
import { Dialog, DialogHeader, DialogPopup, DialogTitle, DialogPanel } from "../ui/dialog";

const notesQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "thread-notes:read",
  tag: WS_METHODS.threadNotesRead,
  staleTimeMs: 0,
});

/** Read through the same authorized service as t3_thread_notes, including remote environments. */
export function ThreadNotesDialog({
  threadRef,
  onOpenChange,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const result = useAtomValue(
    notesQuery({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Thread notes</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {AsyncResult.isFailure(result) ? (
            <p role="alert">Thread notes are unavailable. Close and reopen to retry.</p>
          ) : AsyncResult.isSuccess(result) ? (
            <div className="flex flex-col gap-4">
              {result.value.notes.length === 0 ? (
                <p className="text-sm text-muted-foreground">No saved notes for this thread.</p>
              ) : null}
              {result.value.notes.map((note) => (
                <article key={note.requestId} className="border-b border-border pb-4">
                  <p className="mb-2 text-xs text-muted-foreground">
                    {new Date(note.createdAt).toLocaleString()}
                  </p>
                  <p className="whitespace-pre-wrap break-words text-sm">{note.content}</p>
                  {note.attachments.length > 0 ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {note.attachments.length} saved attachments
                    </p>
                  ) : null}
                </article>
              ))}
              {result.value.truncated ? (
                <p className="text-xs text-muted-foreground">
                  Showing recent notes; older notes remain saved.
                </p>
              ) : null}
            </div>
          ) : (
            <p role="status">Loading notes…</p>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
