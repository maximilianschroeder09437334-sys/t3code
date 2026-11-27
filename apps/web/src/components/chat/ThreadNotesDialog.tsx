import type { EnvironmentId, ThreadId, ThreadNote, ThreadNotesListResult } from "@t3tools/contracts";

import { useClientSettings } from "../../hooks/useSettings";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { formatDayAwareTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

/** Read-only view of the notes agents saved on this thread. Loads only while open. */
export function ThreadNotesDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Thread notes</DialogTitle>
          <DialogDescription>What agents saved on this thread.</DialogDescription>
        </DialogHeader>
        {props.open ? (
          <ThreadNotesContent environmentId={props.environmentId} threadId={props.threadId} />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function ThreadNotesContent(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const query = useEnvironmentQuery<ThreadNotesListResult, unknown>(
    orchestrationEnvironment.threadNotes({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    }),
  );
  const notes = query.data?.notes;
  return (
    <>
      <DialogPanel>
        {query.error !== null ? (
          <p className="text-sm text-destructive-foreground">{query.error}</p>
        ) : notes === undefined ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : notes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No notes saved on this thread yet.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {notes.map((note) => (
              <ThreadNoteEntry key={note.requestId} note={note} />
            ))}
            {query.data?.truncated ? (
              <p className="text-xs text-muted-foreground">Older notes are not shown.</p>
            ) : null}
          </div>
        )}
      </DialogPanel>
      <DialogFooter variant="bare">
        <Button size="sm" variant="outline" disabled={query.isPending} onClick={query.refresh}>
          Refresh
        </Button>
      </DialogFooter>
    </>
  );
}

function ThreadNoteEntry(props: { readonly note: ThreadNote }) {
  const { note } = props;
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  return (
    <section aria-label="Thread note" className="flex min-w-0 flex-col gap-1">
      <span className="text-xs text-muted-foreground">
        {formatDayAwareTimestamp(note.createdAt, timestampFormat)}
      </span>
      <p className="whitespace-pre-wrap break-words text-sm text-foreground">{note.content}</p>
      {note.attachments.length === 0 ? null : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs text-muted-foreground">
          {note.attachments.map((attachment) => (
            <li key={attachment.id} className="truncate">
              {attachment.name}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
