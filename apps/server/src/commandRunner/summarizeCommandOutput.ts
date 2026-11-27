export interface OutputSummaryLimits {
  /** Lines of a failing command's tail to return. */
  readonly tailLines: number;
  /** First matched lines returned per command; later ones go to the last-matches window. */
  readonly headMatchedLines: number;
  /** Last matched lines returned per command, so late errors survive a noisy start. */
  readonly tailMatchedLines: number;
  /** Text budget for returned matched lines, split evenly between first and last. */
  readonly maxMatchedChars: number;
  /** Longer kept lines are cut around their match; the log has the full text. */
  readonly maxLineChars: number;
  /** A line still unbroken at this length is split here, bounding memory and match cost. */
  readonly maxBufferedLineChars: number;
}

export const DEFAULT_OUTPUT_SUMMARY_LIMITS: OutputSummaryLimits = {
  tailLines: 30,
  headMatchedLines: 100,
  tailMatchedLines: 100,
  maxMatchedChars: 64_000,
  maxLineChars: 2_000,
  maxBufferedLineChars: 64 * 1024,
};

/** Case-insensitive regex sources. Callers may add literal text, never remove them. */
export const DEFAULT_MATCH_PATTERNS: ReadonlyArray<string> = [
  "error",
  "warn",
  "fail",
  "exception",
  "fatal",
  "panic",
  "traceback",
  "denied",
];

export interface MatchedLine {
  /** 1-based line number within this command's output. */
  readonly line: number;
  readonly text: string;
}

export interface CommandOutputSummary {
  readonly lineCount: number;
  readonly matchedLineCount: number;
  /** The first and the last matched lines, in output order. */
  readonly matchedLines: ReadonlyArray<MatchedLine>;
  /** Matched lines between the first and last returned ones, only in the log. */
  readonly matchedLinesInLogOnly: number;
  /** The last lines, present only for a failed command. */
  readonly tail?: ReadonlyArray<string>;
}

// oxlint-disable-next-line no-control-regex -- ANSI escapes are control characters by definition.
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const LINE_BREAK = /\r\n|\r|\n/;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Caller additions are literal text: a caller regex could backtrack and stall the server. */
export const compileMatchPatterns = (extra: ReadonlyArray<string> = []): RegExp =>
  new RegExp(
    [...DEFAULT_MATCH_PATTERNS, ...extra.map(escapeRegExp)]
      .map((source) => `(?:${source})`)
      .join("|"),
    "i",
  );

const clip = (text: string, maxChars: number, around = 0): string => {
  if (text.length <= maxChars) return text;
  const start = Math.max(0, Math.min(around - Math.floor(maxChars / 2), text.length - maxChars));
  const end = start + maxChars;
  return `${start > 0 ? `(${start} chars before in log) ...` : ""}${text.slice(start, end)}${
    end < text.length ? `... (${text.length - end} more chars in log)` : ""
  }`;
};

/**
 * Splits a decoded stream into lines at \n, \r\n or a lone \r (progress redraws), holding a
 * partial last line until more text or `flush`.
 */
export class LineSplitter {
  readonly #maxLineChars: number;
  #pending = "";

  constructor(maxLineChars = DEFAULT_OUTPUT_SUMMARY_LIMITS.maxBufferedLineChars) {
    this.#maxLineChars = maxLineChars;
  }

  push(chunk: string): Array<string> {
    let text = this.#pending + chunk;
    // A trailing \r may be the first half of a \r\n split across chunks.
    const heldReturn = text.endsWith("\r");
    if (heldReturn) text = text.slice(0, -1);
    const lines = text.split(LINE_BREAK);
    let rest = lines.pop() ?? "";
    while (rest.length >= this.#maxLineChars) {
      lines.push(rest.slice(0, this.#maxLineChars));
      rest = rest.slice(this.#maxLineChars);
    }
    this.#pending = heldReturn ? `${rest}\r` : rest;
    return lines;
  }

  flush(): Array<string> {
    const rest = this.#pending.endsWith("\r") ? this.#pending.slice(0, -1) : this.#pending;
    const hadPending = this.#pending !== "";
    this.#pending = "";
    return hadPending ? [rest] : [];
  }
}

/** Summarises one command's output line by line, so memory stays bounded by the limits. */
export class OutputSummarizer {
  readonly #pattern: RegExp;
  readonly #limits: OutputSummaryLimits;
  readonly #head: Array<MatchedLine> = [];
  readonly #lastMatches: Array<MatchedLine> = [];
  readonly #tail: Array<string> = [];
  #headChars = 0;
  #lastMatchesChars = 0;
  #headFull = false;
  #lineCount = 0;
  #matchedLineCount = 0;

  constructor(pattern: RegExp, limits: OutputSummaryLimits = DEFAULT_OUTPUT_SUMMARY_LIMITS) {
    this.#pattern = pattern;
    this.#limits = limits;
  }

  addLine(raw: string): void {
    this.#lineCount += 1;
    const text = raw.replace(ANSI_ESCAPE, "");
    const match = this.#pattern.exec(text);
    if (match !== null) this.#addMatch(text, match.index);
    if (this.#limits.tailLines > 0) {
      this.#tail.push(text);
      if (this.#tail.length > this.#limits.tailLines) this.#tail.shift();
    }
  }

  #addMatch(text: string, index: number): void {
    this.#matchedLineCount += 1;
    const entry = { line: this.#lineCount, text: clip(text, this.#limits.maxLineChars, index) };
    const halfBudget = Math.floor(this.#limits.maxMatchedChars / 2);
    if (!this.#headFull) {
      if (
        this.#head.length < this.#limits.headMatchedLines &&
        this.#headChars + entry.text.length <= halfBudget
      ) {
        this.#head.push(entry);
        this.#headChars += entry.text.length;
        return;
      }
      this.#headFull = true;
    }
    this.#lastMatches.push(entry);
    this.#lastMatchesChars += entry.text.length;
    while (
      this.#lastMatches.length > this.#limits.tailMatchedLines ||
      (this.#lastMatchesChars > halfBudget && this.#lastMatches.length > 1)
    ) {
      this.#lastMatchesChars -= this.#lastMatches.shift()?.text.length ?? 0;
    }
  }

  finish(failed: boolean): CommandOutputSummary {
    const matchedLines = [...this.#head, ...this.#lastMatches];
    return {
      lineCount: this.#lineCount,
      matchedLineCount: this.#matchedLineCount,
      matchedLines,
      matchedLinesInLogOnly: this.#matchedLineCount - matchedLines.length,
      ...(failed
        ? {
            tail: this.#tail.map((line) =>
              clip(line, this.#limits.maxLineChars, this.#pattern.exec(line)?.index ?? 0),
            ),
          }
        : {}),
    };
  }
}

/** Summarises complete text in one call. */
export const summarizeCommandOutput = (
  text: string,
  options: {
    readonly failed: boolean;
    readonly pattern?: RegExp;
    readonly limits?: OutputSummaryLimits;
  },
): CommandOutputSummary => {
  const summarizer = new OutputSummarizer(
    options.pattern ?? compileMatchPatterns(),
    options.limits,
  );
  const splitter = new LineSplitter(options.limits?.maxBufferedLineChars);
  for (const line of [...splitter.push(text), ...splitter.flush()]) summarizer.addLine(line);
  return summarizer.finish(options.failed);
};
