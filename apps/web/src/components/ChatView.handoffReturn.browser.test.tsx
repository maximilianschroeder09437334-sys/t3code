import { createMemoryHistory } from "@tanstack/react-router";
import { EventId, RunId, RuntimeRequestId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  acceptPendingCommand,
  dispatchedCommands,
  rejectPendingCommand,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it("retries a rejected Return without navigating until the retry succeeds", async () => {
  const original = threadWithHistory("original", 1);
  const replacement = threadWithHistory("replacement", 1);
  const requestId = RuntimeRequestId.make("parked-review");
  const generation = "parked-generation";
  using _environment = installFakeEnvironment(
    [
      {
        ...original,
        handoffTransfer: {
          state: "released",
          sourceThreadId: original.id,
          successorThreadId: replacement.id,
          requestId,
          generation,
          runId: RunId.make("replacement-run"),
          recoveryCount: 1,
          parkedRecovery: {
            reason: "replacement-lost-after-bootstrap",
            bootstrapEventId: EventId.make("replacement-bootstrap"),
            effectId: "replacement-effect",
          },
        },
      },
      { ...replacement, handoffSourceThreadId: original.id },
    ],
    { acceptCommands: true, holdCommand: (command) => command.type === "handoff.transfer.reverse" },
  );
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const replacementPath = `/${ENVIRONMENT_ID}/${replacement.id}`;
  const originalPath = `/${ENVIRONMENT_ID}/${original.id}`;
  const router = getRouter(createMemoryHistory({ initialEntries: [replacementPath] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  const button = page.getByRole("button", { name: "Return to original thread" });
  const requests = () =>
    dispatchedCommands()
      .filter((command) => command.type === "handoff.transfer.reverse")
      .map(({ threadId, requestId, generation }) => ({ threadId, requestId, generation }));
  const exact = { threadId: original.id, requestId, generation };

  await expect.element(button).toBeEnabled();
  await button.click();
  await vi.waitFor(() => expect(requests()).toEqual([exact]));
  await expect.element(button).toBeDisabled();
  await rejectPendingCommand("temporary Return failure");
  await expect.element(page.getByText("Could not return to the original thread")).toBeVisible();
  await expect.element(button).toBeEnabled();
  expect(router.state.location.pathname).toBe(replacementPath);

  await button.click();
  await vi.waitFor(() => expect(requests()).toEqual([exact, exact]));
  await expect.element(button).toBeDisabled();
  expect(router.state.location.pathname).toBe(replacementPath);
  await acceptPendingCommand();
  await vi.waitFor(() => expect(router.state.location.pathname).toBe(originalPath));
});
