import { describe, expect, it } from "@effect/vitest";

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

  it("keeps the first and the last matches and counts the ones between as log-only", () => {
    const limits = { ...DEFAULT_OUTPUT_SUMMARY_LIMITS, headMatchedLines: 2, tailMatchedLines: 2 };
    const summary = summarizeCommandOutput(
      [...noise(7, "warning"), "Error: the late one"].join("\n"),
      { failed: false, limits },
    );
    expect(summary.matchedLines.map((match) => match.line)).toEqual([1, 2, 7, 8]);
    expect(summary.matchedLines.at(-1)?.text).toBe("Error: the late one");
    expect(summary.matchedLineCount).toBe(8);
    expect(summary.matchedLinesInLogOnly).toBe(4);

    const atLimit = summarizeCommandOutput(noise(4, "error").join("\n"), {
      failed: false,
      limits,
    });
    expect(atLimit.matchedLines).toHaveLength(4);
    expect(atLimit.matchedLinesInLogOnly).toBe(0);
  });

  it("keeps returned matches within the text budget and still returns the last one", () => {
    const summary = summarizeCommandOutput(
      [...noise(50, `warning ${"w".repeat(90)}`), "Error: last"].join("\n"),
      { failed: false, limits: { ...DEFAULT_OUTPUT_SUMMARY_LIMITS, maxMatchedChars: 1_000 } },
    );
    const returnedChars = summary.matchedLines.reduce((sum, match) => sum + match.text.length, 0);
    expect(returnedChars).toBeLessThanOrEqual(1_000);
    expect(summary.matchedLines.at(-1)).toEqual({ line: 51, text: "Error: last" });
    expect(summary.matchedLinesInLogOnly).toBe(51 - summary.matchedLines.length);
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

  it("finds an error after carriage-return progress and clips around the match", () => {
    const progress = Array.from({ length: 400 }, (_, i) => `frame=${i} fps=60 size=1kB`).join("\r");
    const summary = summarizeCommandOutput(
      `${progress}\r${"x".repeat(3_000)} Conversion failed!\n`,
      { failed: true, limits: { ...DEFAULT_OUTPUT_SUMMARY_LIMITS, maxLineChars: 40 } },
    );
    expect(summary.lineCount).toBe(401);
    expect(summary.matchedLines).toHaveLength(1);
    expect(summary.matchedLines[0]?.line).toBe(401);
    expect(summary.matchedLines[0]?.text).toContain("Conversion failed!");
    expect(summary.matchedLines[0]?.text).toMatch(/^\(\d+ chars before in log\) \.\.\./);
    expect(summary.tail?.at(-1)).toContain("Conversion failed!");
  });

  it("adds caller patterns to the defaults instead of replacing them", () => {
    const summary = summarizeCommandOutput("error one\nsegfault two\nfine", {
      failed: false,
      pattern: compileMatchPatterns(["segfault"]),
    });
    expect(summary.matchedLines.map((match) => match.text)).toEqual(["error one", "segfault two"]);
  });

  it("treats caller patterns as literal text, never as a regex", () => {
    const pattern = compileMatchPatterns(["(a+)+$", "[x]"]);
    expect(pattern.test(`${"a".repeat(40)}!`)).toBe(false);
    expect(pattern.test("saw (a+)+$ here")).toBe(true);
    expect(pattern.test("x")).toBe(false);
    expect(pattern.test("[X]")).toBe(true);
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

  it("breaks at a lone carriage return but joins a CRLF split across chunks", () => {
    const splitter = new LineSplitter();
    expect(splitter.push("frame=1\rframe=2\r")).toEqual(["frame=1"]);
    expect(splitter.push("\nnext\r")).toEqual(["frame=2"]);
    expect(splitter.push("after")).toEqual(["next"]);
    expect(splitter.flush()).toEqual(["after"]);
  });

  it("splits a line that never ends at the buffered-line limit", () => {
    const splitter = new LineSplitter(4);
    expect(splitter.push("abcdefghij")).toEqual(["abcd", "efgh"]);
    expect(splitter.push("k\n")).toEqual(["ijk"]);
  });
});
