import {
  deriveHomeDashboardRows,
  type HomeDashboardRow as MobileHomeRow,
} from "@t3tools/client-runtime/state/homeDashboard";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";

export type { MobileHomeRow };

export function deriveMobileHomeRows(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly now: string;
  readonly delegatedUnderParent?: ReadonlySet<string>;
}): ReadonlyArray<MobileHomeRow> {
  return deriveHomeDashboardRows(input);
}
