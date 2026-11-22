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

/** Parses only the first ordered item under Next steps in order in a completed report. */
export function parseHomeNextStep(report: string): HomeNextStep {
  const step = firstHomeNextStepText(report);
  if (!step) return null;
  if (/^Maxi:\s*nothing needed right now\.?\s*$/iu.test(step)) return { kind: "none" };
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

export function firstHomeNextStepText(report: string): string | null {
  const section = /\*\*Next steps in order\*\*\s*([\s\S]*)/iu.exec(report)?.[1];
  const first = section
    ? section
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .find((line) => /^(?:\d+[.)]|[-*])\s+\S/u.test(line))
    : report.trim();
  if (!first) return null;
  return first.replace(/^(?:\d+[.)]|[-*])\s+/u, "").trim();
}

/** First actionable Maxi step anywhere in the ordered list, used for attention notifications. */
export function parseHomeActionableMaxiStep(report: string): string | null {
  const section = /\*\*Next steps in order\*\*\s*([\s\S]*)/iu.exec(report)?.[1];
  if (!section) return null;
  for (const line of section.split(/\r?\n/u)) {
    const step = line
      .trim()
      .replace(/^(?:\d+[.)]|[-*])\s+/u, "")
      .trim();
    if (!/^Maxi:\s*\S/iu.test(step)) continue;
    if (/^Maxi:\s*nothing needed right now\.?\s*$/iu.test(step)) continue;
    return step.replace(/^Maxi:\s*/iu, "");
  }
  return null;
}
