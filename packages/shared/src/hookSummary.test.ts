import { describe, expect, it } from "vite-plus/test";
import { sha256 } from "@noble/hashes/sha2";
import { hookSummary } from "./hookSummary.ts";

const hash = (script: string) =>
  Array.from(sha256(new TextEncoder().encode(script)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

describe("hookSummary", () => {
  it("uses the known description only for its exact reviewed script hash", () => {
    const script = String.raw`const branch = input.payload?.branch;
if (typeof branch !== "string" || branch.trim() === "") {
  return { decision: "block", message: "Push blocked: branch name is missing or blank." };
}
const name = branch.trim().replace(/^refs\/heads\//i, "").toLowerCase();
if (name === "main" || name === "master") {
  return { decision: "block", message: "Push blocked: pushes to main and master are not allowed." };
}
return { decision: "allow" };`;
    expect(hookSummary({ script, scriptSha256: hash(script) })).toContain(
      "Git commands outside T3 are not covered",
    );
    expect(
      hookSummary({
        script: "other script",
        scriptSha256: "529009fc7a5653dd77a37b698c3781339d16c328e2dfdc129434f7c5906756b4",
      }),
    ).toBeNull();
  });

  it("reads a description from the script itself and does not use later comments", () => {
    const script = "// Description: Blocks T3 writes; external writes are not covered.\nreturn {};";
    expect(
      hookSummary({
        script,
        scriptSha256: hash(script),
      }),
    ).toBe("Blocks T3 writes; external writes are not covered.");
    const later = "return {};\n// Description: not the first line";
    expect(hookSummary({ script: later, scriptSha256: hash(later) })).toBeNull();
  });
});
