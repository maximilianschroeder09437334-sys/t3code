import { describe, expect, it } from "vitest";

import {
  compileMatchPatterns,
  DEFAULT_OUTPUT_SUMMARY_LIMITS,
  LineSplitter,
  summarizeCommandOutput,
} from "./summarizeCommandOutput.ts";

const noise = (count: number, prefix = "ok") =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`);

describe("summarizeCommandOutput", () => {
  it("keeps every error and warning line, case-insensitively, with its line number", () => {
    const lines = [
      ...noise(400),
      "src/a.ts(3,1): ERROR TS2304: Cannot find name 'x'.",
      ...noise(400),
      "Warning: deprecated option",
      "\u001b[31mTypeError\u001b[0m: boom",
      ...noise(400),
    ];
    const summary = summarizeCommandOutput(lines.join("\n"), { failed: false });

    expect(summary.lineCount).toBe(1203);
    expect(summary.matchedLines).toEqual([
      { line: 401, text: "src/a.ts(3,1): ERROR TS2304: Cannot find name 'x'." },
      { line: 802, text: "Warning: deprecated option" },
      { line: 803, text: "TypeError: boom" },
    ]);
    expect(summary.matchedLineCount).toBe(3);
    expect(summary.matchedLinesInLogOnly).toBe(0);
    expect(summary.tail).toBeUndefined();
  });

  it("returns the last lines of a failed command, even when they match nothing", () => {
    const summary = summarizeCommandOutput([...noise(100), "exit status 2"].join("\r\n"), {
      failed: true,
      limits: { ...DEFAULT_OUTPUT_SUMMARY_LIMITS, tailLines: 3 },
    });

    expect(summary.lineCount).toBe(101);
    expect(summary.matchedLines).toEqual([]);
    expect(summary.tail).toEqual(["ok 99", "ok 100", "exit status 2"]);
  });

  it("caps matched lines only above the limit and counts the rest as log-only", () => {
    const summary = summarizeCommandOutput(noise(7, "error").join("\n"), {
      failed: false,
      limits: { ...DEFAULT_OUTPUT_SUMMARY_LIMITS, maxMatchedLines: 5 },
    });
    expect(summary.matchedLines.map((match) => match.line)).toEqual([1, 2, 3, 4, 5]);
    expect(summary.matchedLineCount).toBe(7);
    expect(summary.matchedLinesInLogOnly).toBe(2);

    const atLimit = summarizeCommandOutput(noise(5, "error").join("\n"), {
      failed: false,
      limits: { ...DEFAULT_OUTPUT_SUMMARY_LIMITS, maxMatchedLines: 5 },
    });
    expect(atLimit.matchedLines).toHaveLength(5);
    expect(atLimit.matchedLinesInLogOnly).toBe(0);
  });

  it("clips a long matched line and says how much is left in the log", () => {
    const summary = summarizeCommandOutput(`error ${"x".repeat(50)}`, {
      failed: false,
      limits: { ...DEFAULT_OUTPUT_SUMMARY_LIMITS, maxLineChars: 10 },
    });
    expect(summary.matchedLines).toEqual([
      { line: 1, text: "error xxxx... (46 more chars in log)" },
    ]);
  });

  it("adds caller patterns to the defaults instead of replacing them", () => {
    const summary = summarizeCommandOutput("error one\nsegfault two\nfine", {
      failed: false,
      pattern: compileMatchPatterns(["segfault"]),
    });
    expect(summary.matchedLines.map((match) => match.text)).toEqual([
      "error one",
      "segfault two",
    ]);
  });
});

describe("LineSplitter", () => {
  it("joins lines split across chunks and flushes a final unterminated line", () => {
    const splitter = new LineSplitter();
    expect(splitter.push("first li")).toEqual([]);
    expect(splitter.push("ne\r\nsecond\nthi")).toEqual(["first line", "second"]);
    expect(splitter.flush()).toEqual(["thi"]);
    expect(splitter.flush()).toEqual([]);
  });
});
