import type { ResolvedThreadWait } from "@t3tools/client-runtime/state/thread-wait";
import { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { HomeWaitingOnLine } from "./home/HomeWaitingOnLine";
import { WaitingOnPopover } from "./WaitingOnPopover";

const navigate = vi.hoisted(() => vi.fn());
vi.mock(import("@tanstack/react-router"), async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: () => navigate,
}));

const env = EnvironmentId.make("environment-test");
const remote = EnvironmentId.make("environment-remote");
const waiter = { environmentId: env, threadId: ThreadId.make("waiter") };
const base = {
  waiterThreadId: waiter.threadId,
  source: "thread_wait" as const,
  kind: "thread" as const,
};
const wait: ResolvedThreadWait = {
  waiting: true,
  targets: [
    {
      ...base,
      title: "Build",
      environmentId: env,
      threadId: ThreadId.make("build"),
      state: "live",
    },
    {
      ...base,
      title: "Explore",
      environmentId: env,
      threadId: null,
      itemId: TurnItemId.make("item-explore"),
      source: "subagent",
      kind: "subagent",
      state: "live",
    },
    {
      ...base,
      title: "Remote",
      environmentId: remote,
      threadId: ThreadId.make("remote"),
      state: "unknown",
      suffix: "not connected",
    },
    {
      ...base,
      title: "Finished",
      environmentId: env,
      threadId: ThreadId.make("done"),
      state: "ended",
    },
  ],
};

const mount = () => {
  navigate.mockReset();
  return render(
    <WaitingOnPopover
      waiter={waiter}
      wait={wait}
      trigger={<button type="button" aria-label="Show what this thread is waiting on" />}
    >
      Waiting
    </WaitingOnPopover>,
  );
};

it("lists open targets and opens a thread target", async () => {
  await using _screen = await mount();
  await page.getByRole("button", { name: "Show what this thread is waiting on" }).click();

  const list = page.getByRole("list", { name: "Waiting on" });
  await expect.element(list).toBeVisible();
  const lines = Array.from((list.element() as HTMLElement).querySelectorAll("li"), (line) =>
    (line.textContent ?? "").replace(/\s+/g, " ").trim(),
  );
  // Ended targets no longer keep the thread waiting, so they are not listed.
  expect(lines).toEqual([
    "Waiting on thread BuildOpen",
    "Waiting on subagent ExploreOpen",
    "Waiting on thread Remote· not connectedOpen",
  ]);
  await expect.element(page.getByRole("button", { name: "Open thread Remote" })).toBeDisabled();

  await page.getByRole("button", { name: "Open thread Build" }).click();
  expect(navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId: env, threadId: ThreadId.make("build") },
    search: {},
  });
  // Open closes the popover.
  await expect.element(list).not.toBeInTheDocument();
});

it("opens a thread-less subagent at its row in the waiting thread", async () => {
  await using _screen = await mount();
  await page.getByRole("button", { name: "Show what this thread is waiting on" }).click();
  await page.getByRole("button", { name: "Open subagent Explore" }).click();
  expect(navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId: env, threadId: waiter.threadId },
    search: { item: "item-explore" },
  });
});

it("opens from the keyboard and closes on Escape with focus back on the trigger", async () => {
  await using _screen = await mount();
  const trigger = page.getByRole("button", { name: "Show what this thread is waiting on" });
  (trigger.element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  const list = page.getByRole("list", { name: "Waiting on" });
  await expect.element(list).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(list).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();
});

it("opens a child, an awaited command and a PR checks target, each where it lives", async () => {
  navigate.mockReset();
  const pullRequestUrl = "https://github.com/owner/repo/pull/42";
  const mixed: ResolvedThreadWait = {
    waiting: true,
    targets: [
      {
        ...base,
        source: "awaited_child",
        kind: "subagent",
        title: "Pipeline child",
        environmentId: env,
        threadId: ThreadId.make("child"),
        state: "live",
      },
      {
        ...base,
        source: "awaited_child",
        kind: "command",
        title: "vp test --run",
        environmentId: env,
        threadId: null,
        taskId: "bwngue5o4",
        itemId: TurnItemId.make("item-bash"),
        state: "live",
      },
      {
        ...base,
        source: "awaited_child",
        kind: "pull_request",
        title: "PR #42 checks",
        environmentId: env,
        threadId: null,
        taskId: "pull-request-watch:github.com/owner/repo#42",
        pullRequestUrl,
        state: "live",
      },
    ],
  };
  const open = async () => {
    await page.getByRole("button", { name: "Show what this thread is waiting on" }).click();
    await expect.element(page.getByRole("list", { name: "Waiting on" })).toBeVisible();
  };
  await using _screen = await render(
    <WaitingOnPopover
      waiter={waiter}
      wait={mixed}
      trigger={<button type="button" aria-label="Show what this thread is waiting on" />}
    >
      Waiting
    </WaitingOnPopover>,
  );
  await open();
  const list = page.getByRole("list", { name: "Waiting on" }).element() as HTMLElement;
  expect(list.querySelectorAll("li")).toHaveLength(3);
  expect(list.querySelectorAll("button")).toHaveLength(3);
  // Each line names the target's kind.
  expect([...list.querySelectorAll("li")].map((line) => line.textContent)).toEqual([
    "Waiting on subagent Pipeline childOpen",
    "Waiting on command vp test --runOpen",
    "Waiting on PR #42 checksOpen",
  ]);

  await page.getByRole("button", { name: "Open subagent Pipeline child" }).click();
  expect(navigate).toHaveBeenLastCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId: env, threadId: ThreadId.make("child") },
    search: {},
  });
  await open();
  await page.getByRole("button", { name: "Open command vp test --run" }).click();
  expect(navigate).toHaveBeenLastCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId: env, threadId: waiter.threadId },
    search: { item: "item-bash" },
  });
  await open();
  await page.getByRole("button", { name: "Open PR #42 checks" }).click();
  expect(navigate).toHaveBeenLastCalledWith({
    to: "/pull-requests",
    search: { involvement: "all", state: "all", selectedUrl: pullRequestUrl },
  });
  expect(navigate).toHaveBeenCalledTimes(3);
});

it("Home names the first target's kind with Open, and +N lists the rest with theirs", async () => {
  navigate.mockReset();
  const thread = { environmentId: env, id: waiter.threadId } as Parameters<
    typeof HomeWaitingOnLine
  >[0]["thread"];
  const homeWait: ResolvedThreadWait = {
    waiting: true,
    targets: [
      {
        waiterThreadId: waiter.threadId,
        source: "awaited_child",
        kind: "subagent",
        title: "Fix tests",
        environmentId: env,
        threadId: ThreadId.make("fix"),
        state: "live",
      },
      {
        waiterThreadId: waiter.threadId,
        source: "awaited_child",
        kind: "command",
        title: "background command",
        environmentId: env,
        threadId: null,
        taskId: "cmd-1",
        state: "live",
      },
    ],
  };
  await using screen = await render(<HomeWaitingOnLine thread={thread} wait={homeWait} />);
  const line = screen.container.textContent?.replace(/\s+/g, " ").trim();
  expect(line).toBe("Waiting on subagent Fix testsOpen+1");
  await page.getByRole("button", { name: "Open subagent Fix tests" }).click();
  expect(navigate).toHaveBeenLastCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId: env, threadId: ThreadId.make("fix") },
    search: {},
  });
  await page.getByRole("button", { name: "Show all 2 things this is waiting on" }).click();
  const list = page.getByRole("list", { name: "Waiting on" }).element() as HTMLElement;
  expect([...list.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
    "Waiting on subagent Fix testsOpen",
    "Waiting on commandOpen",
  ]);
});
