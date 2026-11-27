export type HomeNextStep =
  | { readonly kind: "needs"; readonly text: string }
  | {
      readonly kind: "wait";
      readonly title: string;
      readonly environmentId: string;
      readonly threadId: string;
    }
  | { readonly kind: "none" }
  | null;

const WAIT_LINK =
  /^T3:\s*WAIT on \[([^\]]+)\]\(https:\/\/app\.t3\.codes\/threads\/([^/]+)\/([^/)]+)\)(?:\s|$)/iu;
const NEXT_STEPS_HEADING =
  /^#{0,6}\s*(?:\*\*|__)?\s*next steps in order\s*:?\s*(?:\*\*|__)?\s*:?$/iu;
const LIST_ITEM = /^(?:\d+[.)]|[-*+])\s+(\S.*)$/u;
const OWNER_LINE = /^(?:\*\*|__)?(?:Maxi|T3)(?:\*\*|__)?:/iu;
const OTHER_HEADING = /^(?:#{1,6}\s|(?:\*\*|__)[^*_].*(?:\*\*|__):?$)/u;
const NOTHING_NEEDED = /^Maxi:\s*nothing (?:is )?needed\b/iu;

/** Parses only the first ordered item under Next steps in order in a completed report. */
export function parseHomeNextStep(report: string): HomeNextStep {
  const step = firstHomeNextStepText(report);
  if (!step) return null;
  if (NOTHING_NEEDED.test(step)) return { kind: "none" };
  if (/^Maxi:\s*\S/iu.test(step)) return { kind: "needs", text: step.replace(/^Maxi:\s*/iu, "") };
  const wait = WAIT_LINK.exec(step);
  if (!wait) return null;
  try {
    return {
      kind: "wait",
      title: wait[1]!,
      environmentId: decodeURIComponent(wait[2]!),
      threadId: decodeURIComponent(wait[3]!),
    };
  } catch {
    return null;
  }
}

/** `**Maxi:** x`, `**Maxi**: x` and `**Maxi: x**` read as `Maxi: x`. */
function normalizeStep(step: string): string {
  return step
    .trim()
    .replace(/^(\*\*|__)((?:Maxi|T3)\s*:.*)\1$/iu, "$2")
    .replace(/^(\*\*|__)(Maxi|T3)\s*(?::\s*\1|\1\s*:)\s*/iu, "$2: ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Ordered steps under the last "Next steps in order" heading of an agent report, or null when the
 * report has no such section. Tolerates bold/plain/`#` headings, `1.`/`1)`/bullet markers and
 * unnumbered `Maxi:`/`T3:` lines; wrapped lines join their step and the next heading ends the list.
 */
export function parseNextSteps(markdown: string): ReadonlyArray<string> | null {
  const lines = markdown.split(/\r?\n/u);
  let start = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (NEXT_STEPS_HEADING.test(lines[index]!.trim())) {
      start = index + 1;
      break;
    }
  }
  if (start < 0) return null;
  const steps: string[] = [];
  let baseIndent: number | undefined;
  for (const raw of lines.slice(start)) {
    const line = raw.trim();
    if (!line) continue;
    const indent = raw.length - raw.trimStart().length;
    const item = LIST_ITEM.exec(line)?.[1];
    const nested = baseIndent !== undefined && indent > baseIndent + 1;
    if (!nested && (item !== undefined || OWNER_LINE.test(line))) {
      baseIndent ??= indent;
      steps.push(normalizeStep(item ?? line));
      continue;
    }
    if (OTHER_HEADING.test(line)) break;
    if (steps.length === 0 || (nested && item !== undefined)) continue;
    if (indent === 0) break;
    steps[steps.length - 1] = normalizeStep(`${steps[steps.length - 1]} ${line}`);
  }
  return steps;
}

/** First step of a report, or a bare single-line step such as the stored `homeFirstNextStep`. */
export function firstHomeNextStepText(report: string): string | null {
  const steps = parseNextSteps(report);
  if (steps !== null) return steps[0] ?? null;
  const bare = report.trim();
  if (!bare || /[\r\n]/u.test(bare)) return null;
  return normalizeStep(bare.replace(/^(?:\d+[.)]|[-*+])\s+/u, "")) || null;
}

/** First actionable Maxi step anywhere in the ordered list, used for attention notifications. */
export function parseHomeActionableMaxiStep(report: string): string | null {
  for (const step of parseNextSteps(report) ?? []) {
    if (!/^Maxi:\s*\S/iu.test(step) || NOTHING_NEEDED.test(step)) continue;
    return step.replace(/^Maxi:\s*/iu, "");
  }
  return null;
}

export function isHomeReportCurrent(input: {
  readonly reportRunId: string;
  readonly latestRunId: string | null;
  readonly reportCompletedAt: number | null;
  readonly latestUserMessageAt: number | null;
}): boolean {
  return (
    input.reportRunId === input.latestRunId &&
    input.reportCompletedAt !== null &&
    (input.latestUserMessageAt === null || input.latestUserMessageAt <= input.reportCompletedAt)
  );
}
