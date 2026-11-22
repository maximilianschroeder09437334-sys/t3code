import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

export interface UsageModelTableRow {
  readonly key: string;
  readonly model: string;
  readonly mark: ReactNode;
  readonly color: string;
  /** Share of the busiest model's value, 0 to 1, or null without a bar. */
  readonly barFraction: number | null;
  readonly primary: ReactNode;
  readonly secondary: string;
  readonly tokens: string;
  readonly figuresClassName: string;
}

/**
 * The model breakdown. Fixed column widths keep it inside a phone's width: the model name wraps
 * anywhere, the rank and second share column appear from `sm` up.
 */
export function UsageModelTable({
  headings,
  rows,
  onSelect,
}: {
  readonly headings: { readonly primary: string; readonly secondary: string };
  readonly rows: readonly UsageModelTableRow[];
  readonly onSelect: (key: string) => void;
}) {
  return (
    <table className="w-full table-fixed text-sm">
      <thead>
        <tr className="border-b border-border text-right text-xs text-muted-foreground">
          <th className="hidden w-10 py-2 pr-3 pl-2 text-left font-normal sm:table-cell">#</th>
          <th className="py-2 pl-2 text-left font-normal sm:pl-0">Model</th>
          <th className="w-24 py-2 pl-3 font-normal sm:w-28 sm:pl-6">{headings.primary}</th>
          <th className="hidden w-28 py-2 pl-6 font-normal sm:table-cell">{headings.secondary}</th>
          <th className="w-20 py-2 pr-2 pl-3 font-normal sm:w-28 sm:pl-6">Tokens</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={5} className="py-6 text-center text-muted-foreground">
              No activity in this window.
            </td>
          </tr>
        ) : (
          rows.map((row, index) => (
            <tr
              key={row.key}
              className="relative border-b border-border/50 text-right whitespace-nowrap text-muted-foreground tabular-nums transition-colors hover:bg-muted/50 has-focus-visible:bg-muted/50"
            >
              <td className="hidden py-2.5 pr-3 pl-2 text-left text-xs sm:table-cell">
                {index + 1}
              </td>
              <td className="py-2.5 pl-2 text-left whitespace-normal sm:pl-0">
                <button
                  type="button"
                  onClick={() => onSelect(row.key)}
                  className={cn(
                    "flex max-w-full min-w-0 items-start gap-2 text-left text-foreground outline-none after:absolute after:inset-0",
                    row.barFraction === null && "py-1",
                  )}
                >
                  <span className="flex h-5 shrink-0 items-center">{row.mark}</span>
                  <span className="min-w-0 wrap-anywhere">{row.model}</span>
                </button>
                {row.barFraction === null ? null : (
                  <div aria-hidden className={cn("mt-1.5 h-0.5 max-w-48", row.figuresClassName)}>
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `max(0.5rem, ${row.barFraction * 100}%)`,
                        backgroundColor: row.color,
                      }}
                    />
                  </div>
                )}
              </td>
              <td className={cn("py-2.5 pl-3 text-foreground sm:pl-6", row.figuresClassName)}>
                {row.primary}
              </td>
              <td className={cn("hidden py-2.5 pl-6 sm:table-cell", row.figuresClassName)}>
                {row.secondary}
              </td>
              <td className={cn("py-2.5 pr-2 pl-3 sm:pl-6", row.figuresClassName)}>{row.tokens}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}
