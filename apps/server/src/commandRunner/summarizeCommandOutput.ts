export interface OutputSummaryLimits {
  /** Lines of a failing command's tail to return. */
  readonly tailLines: number;
  /** Matched lines returned per command before the rest are only counted. */
  readonly maxMatchedLines: number;
  /** Longer kept lines are cut here; the log has the full text. */
  readonly maxLineChars: number;
}

export const DEFAULT_OUTPUT_SUMMARY_LIMITS: OutputSummaryLimits = {
  tailLines: 30,
  maxMatchedLines: 500,
  maxLineChars: 2_000,
};

/** Case-insensitive regex sources. Callers may add to them, never remove them. */
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
  readonly matchedLines: ReadonlyArray<MatchedLine>;
  /** Matched lines past `maxMatchedLines`, only in the log. */
  readonly matchedLinesInLogOnly: number;
  /** The last lines, present only for a failed command. */
  readonly tail?: ReadonlyArray<string>;
}

// oxlint-disable-next-line no-control-regex -- ANSI escapes are control characters by definition.
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

export const compileMatchPatterns = (extra: ReadonlyArray<string> = []): RegExp =>
  new RegExp([...DEFAULT_MATCH_PATTERNS, ...extra].map((source) => `(?:${source})`).join("|"), "i");

const clip = (text: string, maxChars: number): string =>
  text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)}... (${text.length - maxChars} more chars in log)`;

/** Splits a decoded stream into lines, holding a partial last line until more text or `flush`. */
export class LineSplitter {
  #pending = "";

  push(chunk: string): Array<string> {
    const parts = (this.#pending + chunk).split("\n");
    this.#pending = parts.pop() ?? "";
    return parts.map((part) => (part.endsWith("\r") ? part.slice(0, -1) : part));
  }

  flush(): Array<string> {
    const rest = this.#pending;
    this.#pending = "";
    return rest === "" ? [] : [rest.endsWith("\r") ? rest.slice(0, -1) : rest];
  }
}

/** Summarises one command's output line by line, so memory stays bounded by the limits. */
export class OutputSummarizer {
  readonly #pattern: RegExp;
  readonly #limits: OutputSummaryLimits;
  readonly #matched: Array<MatchedLine> = [];
  readonly #tail: Array<string> = [];
  #lineCount = 0;
  #matchedLineCount = 0;

  constructor(pattern: RegExp, limits: OutputSummaryLimits = DEFAULT_OUTPUT_SUMMARY_LIMITS) {
    this.#pattern = pattern;
    this.#limits = limits;
  }

  addLine(raw: string): void {
    this.#lineCount += 1;
    const text = raw.replace(ANSI_ESCAPE, "");
    if (this.#pattern.test(text)) {
      this.#matchedLineCount += 1;
      if (this.#matched.length < this.#limits.maxMatchedLines) {
        this.#matched.push({ line: this.#lineCount, text: clip(text, this.#limits.maxLineChars) });
      }
    }
    if (this.#limits.tailLines > 0) {
      this.#tail.push(text);
      if (this.#tail.length > this.#limits.tailLines) this.#tail.shift();
    }
  }

  finish(failed: boolean): CommandOutputSummary {
    return {
      lineCount: this.#lineCount,
      matchedLineCount: this.#matchedLineCount,
      matchedLines: this.#matched,
      matchedLinesInLogOnly: this.#matchedLineCount - this.#matched.length,
      ...(failed ? { tail: this.#tail.map((line) => clip(line, this.#limits.maxLineChars)) } : {}),
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
  const splitter = new LineSplitter();
  for (const line of [...splitter.push(text), ...splitter.flush()]) summarizer.addLine(line);
  return summarizer.finish(options.failed);
};
