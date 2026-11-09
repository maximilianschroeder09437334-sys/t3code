import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import "../../index.css";

const state = vi.hoisted(() => ({ save: vi.fn(), saved: vi.fn() }));
vi.mock("../../state/hooks", () => ({ hookCreateDraft: { permissionAtom: () => null } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.save }));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () => true,
}));

import { HookBuilder } from "./HookBuilder";

it.each([390, 1280])(
  "saves a reviewable inactive recipe without overflow at %spx",
  async (width) => {
    vi.clearAllMocks();
    state.save.mockResolvedValue({ _tag: "Success", value: {} });
    await page.viewport(width, 900);
    await using screen = await render(
      <div style={{ width: "100%", maxWidth: 800 }}>
        <HookBuilder
          environmentId={EnvironmentId.make("test-environment")}
          projectId={ProjectId.make("test-project")}
          scope="project"
          onSaved={state.saved}
        />
      </div>,
      { router: false },
    );
    await expect.element(screen.getByRole("button", { name: "Save inactive draft" })).toBeEnabled();
    expect(screen.container.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);
    await screen.getByRole("button", { name: "Save inactive draft" }).click();
    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent(
        "Saved an inactive draft. Review the exact script, event and scope below before approving.",
      );
    expect(state.saved).toHaveBeenCalledOnce();
    expect(state.save).toHaveBeenCalledExactlyOnceWith({
      environmentId: "test-environment",
      input: {
        projectId: "test-project",
        scope: "project",
        name: expect.any(String),
        event: "thread_stalled",
        script: expect.stringContaining("allowIdleResume"),
      },
    });
  },
);
