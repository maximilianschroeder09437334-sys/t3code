import {
  ChatAttachmentId,
  EnvironmentId,
  ThreadId,
  type ThreadNotesListResult,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";
import { ThreadNotesDialog } from "./ThreadNotesDialog";

// Set VITE_T3_PROOF_DIR (a folder inside the repo, which Vite may write to) to also save PNGs there.
const PROOF_DIR: string | undefined = import.meta.env.VITE_T3_PROOF_DIR;

const query = vi.hoisted(() => ({
  data: undefined as unknown,
  error: null as string | null,
  refresh: (() => {}) as () => void,
}));
vi.mock(import("../../state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuery: (() => ({
    data: query.data,
    dataUpdatedAt: 0,
    error: query.error,
    failure: null,
    isPending: false,
    isSuccess: query.data !== undefined,
    refresh: query.refresh,
  })) as never,
}));

const environmentId = EnvironmentId.make("environment-test");
const threadId = ThreadId.make("thread-notes");

function setup(notes: ThreadNotesListResult["notes"], truncated = false) {
  query.data = { threadId, notes, truncated } satisfies ThreadNotesListResult;
  query.error = null;
  query.refresh = vi.fn();
  return query;
}

const dialog = (open = true) => (
  <ThreadNotesDialog
    environmentId={environmentId}
    threadId={threadId}
    open={open}
    onOpenChange={() => {}}
  />
);

it("lists each saved note with its attachment names and refreshes on demand", async () => {
  const state = setup(
    [
      {
        requestId: "note-1",
        createdAt: "2026-11-26T09:15:00.000Z",
        content: "Proxy render finished.\nNext: grade pass on reel 2.",
        attachments: [],
      },
      {
        requestId: "note-2",
        createdAt: "2026-11-27T08:00:00.000Z",
        content: "Dropped-frame report attached.",
        attachments: [
          {
            type: "file",
            id: ChatAttachmentId.make("attachment-1"),
            name: "dropped-frames-report.html",
            mimeType: "text/html",
            sizeBytes: 2048,
          },
        ],
      },
    ],
    true,
  );
  await page.viewport(1000, 700);
  await using _screen = await render(dialog());

  await expect.element(page.getByRole("heading", { name: "Thread notes" })).toBeVisible();
  const notes = page.getByRole("region", { name: "Thread note" });
  await expect
    .element(notes.nth(0).getByText("Proxy render finished. Next: grade pass on reel 2."))
    .toBeVisible();
  await expect.element(notes.nth(1).getByText("Dropped-frame report attached.")).toBeVisible();
  await expect.element(notes.nth(1).getByText("dropped-frames-report.html")).toBeVisible();
  expect(notes.elements()).toHaveLength(2);
  expect(notes.nth(0).element().querySelector("li")).toBeNull();
  await expect.element(page.getByText("Older notes are not shown.")).toBeVisible();

  await page.getByRole("button", { name: "Refresh" }).click();
  expect(state.refresh).toHaveBeenCalledTimes(1);

  if (PROOF_DIR) await page.screenshot({ path: `${PROOF_DIR}/1.3-thread-notes-dialog.png` });
});

it("says so when the thread has no notes, and loads nothing while closed", async () => {
  setup([]);
  await page.viewport(1000, 700);
  await using screen = await render(dialog());

  await expect.element(page.getByText("No notes saved on this thread yet.")).toBeVisible();
  expect(page.getByRole("region", { name: "Thread note" }).elements()).toHaveLength(0);
  if (PROOF_DIR) await page.screenshot({ path: `${PROOF_DIR}/1.3-thread-notes-dialog-empty.png` });

  await screen.rerender(dialog(false));
  await expect
    .element(page.getByText("No notes saved on this thread yet."))
    .not.toBeInTheDocument();
});

it("shows the read error instead of notes", async () => {
  setup([]);
  query.data = undefined;
  query.error = "Thread notes could not be read.";
  await using _screen = await render(dialog());

  await expect.element(page.getByText("Thread notes could not be read.")).toBeVisible();
});
