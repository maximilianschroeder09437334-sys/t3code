import appCss from "../../index.css?inline";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ThreadRuntimeSummary } from "@t3tools/client-runtime/state/models";
import type { ResolvedThreadWait } from "@t3tools/client-runtime/state/thread-wait";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { useThreadWait } from "../../state/threadWaits";
import { makeThreadFixture } from "../../test-fixtures";
import type { SidebarThreadSummary } from "../../types";
import { SortableThreadRow } from "./SidebarThreadRow";

const navigate = vi.hoisted(() => vi.fn());
vi.mock(import("@tanstack/react-router"), async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: () => navigate,
}));
vi.mock("../../state/threadWaits", { spy: true });

const env = EnvironmentId.make("environment-test");
const waiterId = ThreadId.make("waiter");
const resolvedWait: ResolvedThreadWait = {
  waiting: true,
  targets: [
    {
      waiterThreadId: waiterId,
      source: "thread_wait",
      kind: "thread",
      title: "Build",
      environmentId: env,
      threadId: ThreadId.make("build"),
      state: "live",
    },
    {
      waiterThreadId: waiterId,
      source: "delegate_wait",
      kind: "thread",
      title: "Review",
      environmentId: env,
      threadId: ThreadId.make("review"),
      state: "live",
      suffix: "needs you",
    },
  ],
};

const runtime = (status: ThreadRuntimeSummary["status"]): ThreadRuntimeSummary => ({
  status,
  activeRunId: null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: "Codex",
  lastError: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
});

// Blocked in its wait tool, so the old rules alone would also say Waiting.
const waiterThread = makeThreadFixture({
  environmentId: env,
  id: waiterId,
  title: "Waiter",
  runtime: runtime("running"),
  blockedOnThreadWait: true,
}) as SidebarThreadSummary;

type Variant = "card" | "folder" | "folder-multiline";

/** Mounts one row with the app's styles; acquire with `await using`. */
async function mountRow(
  variant: Variant,
  thread: SidebarThreadSummary,
  wait: ResolvedThreadWait | undefined,
) {
  // The app's own styles decide whether hover fades the status. Without transitions the
  // hovered state applies at once.
  const styles = document.createElement("style");
  styles.textContent = `${appCss}\n*, *::before, *::after { transition: none !important; }`;
  document.head.append(styles);
  navigate.mockReset();
  vi.mocked(useThreadWait).mockReturnValue(wait);
  const callbacks = {
    onThreadClick: vi.fn(),
    onThreadActivate: vi.fn(),
    onStartRename: vi.fn(),
    onContextMenu: vi.fn(),
  };
  const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const screen = await render(
    <DndContext>
      <SortableContext items={[key]}>
        <ul style={{ width: 320 }}>
          <SortableThreadRow
            sortableId={key}
            sortableDisabled
            contextDrag={false}
            thread={thread}
            variant={variant}
            variantAction="settle"
            settlementSupported
            snoozeSupported={false}
            pinningSupported={false}
            isPinned={false}
            dropVerb={null}
            dragOverPinned={false}
            sweepAction={null}
            snoozeWakeLabelText={null}
            wokeAt={null}
            isActive={false}
            isRouteThread={false}
            readOpensPullRequestsInRightPanel={() => false}
            jumpLabel={null}
            currentEnvironmentId={env}
            environmentLabel={null}
            environmentMachine="server"
            scratchMachineLabel={null}
            project={null}
            projectDisplayName="Project"
            providerEntryByInstanceId={new Map()}
            timestampFormat="locale"
            onCommitRename={vi.fn()}
            onCancelRename={vi.fn()}
            onRenameTitleChange={vi.fn()}
            isRenaming={false}
            renamingTitle=""
            onSettle={vi.fn()}
            onActionSweepStart={vi.fn()}
            onUnsettle={vi.fn()}
            onSnooze={vi.fn()}
            onUnsnooze={vi.fn()}
            onUnpin={vi.fn()}
            onAcknowledgeWoke={vi.fn()}
            {...callbacks}
          />
        </ul>
      </SortableContext>
    </DndContext>,
  ).catch((error: unknown) => {
    styles.remove();
    throw error;
  });
  return {
    callbacks,
    async [Symbol.asyncDispose]() {
      try {
        await screen[Symbol.asyncDispose]();
      } finally {
        styles.remove();
      }
    },
  };
}

type RowCallbacks = Awaited<ReturnType<typeof mountRow>>["callbacks"];

function expectRowUntouched(callbacks: RowCallbacks) {
  expect(callbacks.onThreadClick).not.toHaveBeenCalled();
  expect(callbacks.onThreadActivate).not.toHaveBeenCalled();
  expect(callbacks.onStartRename).not.toHaveBeenCalled();
  expect(callbacks.onContextMenu).not.toHaveBeenCalled();
}

const waitingTrigger = () =>
  page.getByRole("button", { name: "Show what this thread is waiting on" });
const waitingList = () => page.getByRole("list", { name: "Waiting on" });

function listLines(): string[] {
  const list = waitingList().element() as HTMLElement;
  return Array.from(list.querySelectorAll("li"), (line) =>
    (line.textContent ?? "").replace(/\s+/g, " ").trim(),
  );
}

function effectiveOpacity(element: Element): number {
  let opacity = 1;
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    opacity *= Number(getComputedStyle(node).opacity);
  }
  return opacity;
}

describe.each(["card", "folder", "folder-multiline"] as const)(
  "%s row with a resolved Waiting",
  (variant) => {
    it("click lists what it waits on with Open per target, without opening the row", async () => {
      await using mounted = await mountRow(variant, waiterThread, resolvedWait);
      const row = page.getByTestId(variant === "card" ? "sidebar-row-card" : "sidebar-row-folder");
      await expect.element(row).toBeInTheDocument();

      await userEvent.click(waitingTrigger());
      await expect.element(waitingList()).toBeVisible();
      expect(listLines()).toEqual([
        "Waiting on thread BuildOpen",
        "Waiting on thread Review· needs youOpen",
      ]);
      expectRowUntouched(mounted.callbacks);

      // Clicks inside the portaled list must not reach the row through React either.
      await userEvent.click(page.getByText("Review", { exact: true }));
      await userEvent.dblClick(page.getByText("Build", { exact: true }));
      await expect.element(waitingList()).toBeVisible();
      expectRowUntouched(mounted.callbacks);

      await userEvent.click(page.getByRole("button", { name: "Open thread Review" }));
      expect(navigate).toHaveBeenCalledExactlyOnceWith({
        to: "/$environmentId/$threadId",
        params: { environmentId: env, threadId: ThreadId.make("review") },
        search: {},
      });
      await expect.element(waitingList()).not.toBeInTheDocument();
      // A double click on the status neither renames nor opens the row.
      await userEvent.dblClick(waitingTrigger());
      expectRowUntouched(mounted.callbacks);
    });

    it.each([
      ["Enter", "{Enter}"],
      ["Space", " "],
    ])("%s on the focused status opens the list; Escape returns focus", async (_name, key) => {
      await using mounted = await mountRow(variant, waiterThread, resolvedWait);
      const trigger = waitingTrigger();
      await expect.element(trigger).toBeInTheDocument();
      (trigger.element() as HTMLElement).focus();
      await expect.element(trigger).toHaveFocus();

      await userEvent.keyboard(key);
      await expect.element(waitingList()).toBeVisible();
      expect(listLines()).toHaveLength(2);
      expectRowUntouched(mounted.callbacks);

      await userEvent.keyboard("{Escape}");
      await expect.element(waitingList()).not.toBeInTheDocument();
      await expect.element(trigger).toHaveFocus();
      expectRowUntouched(mounted.callbacks);
    });

    it("stays visible and clickable while the row is hovered", async () => {
      await using mounted = await mountRow(variant, waiterThread, resolvedWait);
      const row = page.getByTestId(variant === "card" ? "sidebar-row-card" : "sidebar-row-folder");
      await userEvent.hover(row);
      const settle = page.getByRole("button", { name: "Settle thread" });
      // The row action only shows on hover, so this proves the hover state applies.
      await expect.poll(() => effectiveOpacity(settle.element())).toBe(1);

      const trigger = waitingTrigger().element() as HTMLElement;
      expect(effectiveOpacity(trigger)).toBe(1);
      const box = trigger.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      expect(hit !== null && trigger.contains(hit), "the row action covers Waiting").toBe(true);

      await userEvent.click(waitingTrigger());
      await expect.element(waitingList()).toBeVisible();
      expectRowUntouched(mounted.callbacks);
    });
  },
);

describe("folder rows without a resolved Waiting", () => {
  const notWaiting: ResolvedThreadWait = { waiting: false, targets: [] };
  it.each([
    {
      name: "Working",
      thread: { runtime: runtime("running") },
      wait: notWaiting,
    },
    {
      name: "Approval",
      thread: { runtime: runtime("running"), hasPendingApprovals: true },
      wait: resolvedWait,
    },
    {
      name: "Failed",
      thread: { runtime: runtime("failed") },
      wait: notWaiting,
    },
    // An older server sends no wait fields; its idle Waiting stays a plain label.
    { name: "Waiting", thread: { runtime: runtime("idle") }, wait: undefined },
  ])("$name stays a plain status that opens the row", async ({ name, thread, wait }) => {
    for (const variant of ["folder", "folder-multiline"] as const) {
      const fixture = makeThreadFixture({
        environmentId: env,
        id: ThreadId.make(`plain-${name}`),
        title: `Plain ${name}`,
        ...thread,
      }) as SidebarThreadSummary;
      await using mounted = await mountRow(variant, fixture, wait);
      const row = page.getByTestId("sidebar-row-folder");
      const label = row.getByText(name, { exact: true });
      await expect.element(label).toBeInTheDocument();
      expect(label.element().closest("button")).toBeNull();
      await expect.element(waitingTrigger()).not.toBeInTheDocument();

      // A click on the label is a click on the row, as before.
      (label.element() as HTMLElement).click();
      expect(mounted.callbacks.onThreadClick).toHaveBeenCalledOnce();

      // As before, the label hides on hover behind the row action.
      await userEvent.hover(row);
      await expect
        .poll(() => effectiveOpacity(page.getByRole("button", { name: "Settle thread" }).element()))
        .toBe(1);
      expect(effectiveOpacity(label.element())).toBe(0);
    }
  });
});
