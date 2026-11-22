import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { UsageModelTable, type UsageModelTableRow } from "./UsageModelTable";

const LONG_MODEL = "claude-opus-4-5-20251101-extended-thinking-preview-fast-1m-context";

function row(key: string, model: string, primary: string): UsageModelTableRow {
  return {
    key,
    model,
    mark: <span className="block size-3.5 rounded-full bg-current" />,
    color: "#d97757",
    barFraction: 1,
    primary,
    secondary: "100%",
    tokens: "999.9M",
    figuresClassName: "",
  };
}

const ROWS = [
  row("claude:long", LONG_MODEL, "$12,345.67"),
  row("codex:gpt-5", "gpt-5.2-codex-max-xhigh", "<0.1%"),
];

describe("UsageModelTable on a phone", () => {
  // Phone widths less the page's 40px of side padding.
  it.each([360, 390, 430])("fits %ipx without horizontal scrolling", async (viewport) => {
    const previous = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(viewport, 800);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(previous.width, previous.height),
    };
    const container = document.createElement("div");
    container.style.width = `${viewport - 40}px`;
    await using screen = await render(
      <UsageModelTable
        headings={{ primary: "Weekly", secondary: "5-hour" }}
        rows={ROWS}
        onSelect={() => {}}
      />,
      { container, router: false },
    );
    const table = screen.container.querySelector("table")!;
    expect(table.scrollWidth).toBeLessThanOrEqual(container.clientWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(viewport);
    // The full model name, the selected window's share and the tokens stay readable.
    await expect.element(screen.getByRole("button", { name: LONG_MODEL })).toBeVisible();
    await expect.element(screen.getByText("$12,345.67")).toBeVisible();
    await expect.element(screen.getByText("<0.1%")).toBeVisible();
    await expect.element(screen.getByText("999.9M").first()).toBeVisible();
    for (const cell of screen.container.querySelectorAll("td")) {
      if (getComputedStyle(cell).display === "none") continue;
      expect(cell.scrollWidth).toBeLessThanOrEqual(cell.clientWidth + 1);
    }
    // The second window and rank show only where there is room.
    await expect.element(screen.getByText("5-hour")).not.toBeVisible();
  });
});
