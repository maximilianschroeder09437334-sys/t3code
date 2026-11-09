import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { HookRemoveControl } from "./HookRemoveControl";

it("shows Remove only for a disabled hook on a supported server", async () => {
  const onRemove = vi.fn();
  await using screen = await render(
    <HookRemoveControl
      hook={{ enabled: true, name: "Guard" }}
      supported
      disabled={false}
      onRemove={onRemove}
    />,
    { router: false },
  );
  await expect
    .element(screen.getByRole("button", { name: "Remove Guard" }))
    .not.toBeInTheDocument();
  await screen.rerender(
    <HookRemoveControl
      hook={{ enabled: false, name: "Guard" }}
      supported
      disabled={false}
      onRemove={onRemove}
    />,
  );
  await screen.getByRole("button", { name: "Remove Guard" }).click();
  expect(onRemove).toHaveBeenCalledOnce();
  await screen.rerender(
    <HookRemoveControl
      hook={{ enabled: false, name: "Guard" }}
      supported={false}
      disabled={false}
      onRemove={onRemove}
    />,
  );
  await expect
    .element(screen.getByRole("button", { name: "Remove Guard" }))
    .not.toBeInTheDocument();
});
