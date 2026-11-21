import { useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { FilePlus2Icon, Trash2Icon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { MessageId, type ChatImageAttachment, type EnvironmentId, type ThreadId } from "@t3tools/contracts";

import { useAssetUrls } from "../../assets/assetUrls";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { randomUUID } from "../../lib/utils";
import {
  threadNotePersistScreenshot,
  threadNotesDelete,
  threadNotesRead,
  threadNotesSave,
} from "../../state/threadNotes";

const fileDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Could not read screenshot."));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read screenshot."));
    reader.readAsDataURL(file);
  });

export function ThreadNotesControl(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState("");
  const [attachments, setAttachments] = useState<ReadonlyArray<ChatImageAttachment>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const query = useMemo(
    () => threadNotesRead({ environmentId: props.environmentId, input: { threadId: props.threadId } }),
    [props.environmentId, props.threadId],
  );
  const result = useAtomValue(query);
  const canWrite = useAtomValue(threadNotesSave.permissionAtom(props.environmentId));
  const notes = result._tag === "Success" ? result.value.notes : [];
  const resources = useMemo(
    () => notes.flatMap((note) => note.attachments.map((attachment) => ({ _tag: "attachment" as const, attachmentId: attachment.id }))),
    [notes],
  );
  const assetUrls = useAssetUrls(props.environmentId, resources);

  const addScreenshot = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const dataUrl = await fileDataUrl(file);
      const saved = await runAtomCommand(appAtomRegistry, threadNotePersistScreenshot, {
        environmentId: props.environmentId,
        input: {
          threadId: props.threadId,
          messageId: MessageId.make(randomUUID()),
          attachments: [{ type: "image", name: file.name, mimeType: file.type, sizeBytes: file.size, dataUrl }],
        },
      });
      if (saved._tag !== "Success") throw new Error("Screenshot upload failed.");
      setAttachments((current) => [
        ...current,
        ...saved.value.attachments.filter((attachment): attachment is ChatImageAttachment => attachment.type === "image"),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Screenshot upload failed.");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (content.trim().length === 0 || busy) return;
    setBusy(true);
    setError(null);
    const saved = await runAtomCommand(appAtomRegistry, threadNotesSave, {
      environmentId: props.environmentId,
      input: {
        threadId: props.threadId,
        requestId: randomUUID(),
        content,
        ...(attachments.length > 0 ? { attachments } : {}),
      },
    });
    setBusy(false);
    if (saved._tag !== "Success") {
      setError("Could not save this note. Check your connection and access.");
      return;
    }
    setContent("");
    setAttachments([]);
    void appAtomRegistry.refresh(query);
  };

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>Thread notes</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Thread notes</DialogTitle>
            <DialogDescription>Durable context shared with agents who can read this environment.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-3">
              {notes.map((note, noteIndex) => (
                <article key={note.requestId} className="rounded-md border p-3">
                  <p className="whitespace-pre-wrap text-sm">{note.content}</p>
                  {note.attachments.map((attachment) => {
                    const attachmentIndex = resources.findIndex((resource) => resource.attachmentId === attachment.id);
                    const url = attachmentIndex >= 0 ? assetUrls[attachmentIndex] : null;
                    return url ? <a key={attachment.id} href={url} target="_blank" rel="noreferrer"><img className="mt-2 max-h-48 rounded object-contain" src={url} alt={attachment.name} /></a> : null;
                  })}
                  <div className="mt-2 flex justify-end">
                    <Button size="icon-xs" variant="ghost-destructive" aria-label="Delete note" disabled={!canWrite} onClick={async () => {
                      const removed = await runAtomCommand(appAtomRegistry, threadNotesDelete, {
                        environmentId: props.environmentId,
                        input: { threadId: props.threadId, requestId: note.requestId },
                      });
                      if (removed._tag === "Success") void appAtomRegistry.refresh(query);
                      else setError("Could not delete this note.");
                    }}><Trash2Icon /></Button>
                  </div>
                  <span className="sr-only">Note {noteIndex + 1}</span>
                </article>
              ))}
              {notes.length === 0 ? <p className="text-sm text-muted-foreground">No notes saved for this thread.</p> : null}
              {result._tag === "Failure" ? <p role="alert" className="text-sm text-destructive">Notes are unavailable with this connection.</p> : null}
              <textarea className="min-h-24 w-full rounded-md border bg-background p-3 text-sm" value={content} onChange={(event) => setContent(event.target.value)} placeholder="Save an important decision, preference, or lasting constraint…" />
              {attachments.map((attachment) => <p key={attachment.id} className="text-xs text-muted-foreground">Screenshot attached: {attachment.name}</p>)}
              <input ref={fileRef} type="file" accept="image/png" className="sr-only" onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (!file) return;
                if (file.size > 10 * 1024 * 1024) { setError("Screenshots must be 10 MB or smaller."); return; }
                void addScreenshot(file);
              }} />
              {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
              <div className="flex justify-between">
                <Button variant="outline" size="sm" disabled={busy || !canWrite} onClick={() => fileRef.current?.click()}><FilePlus2Icon /> Add screenshot</Button>
                <Button size="sm" disabled={busy || !canWrite || content.trim().length === 0} onClick={() => void save()}>Save note</Button>
              </div>
            </div>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}
