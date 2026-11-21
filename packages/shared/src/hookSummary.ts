import type { HookDefinition } from "@t3tools/contracts";
import { sha256 } from "@noble/hashes/sha2";

// These descriptions apply only to the exact scripts reviewed by the user.
const KNOWN_SUMMARIES: Readonly<Record<string, string>> = {
  "529009fc7a5653dd77a37b698c3781339d16c328e2dfdc129434f7c5906756b4":
    "Blocks T3-managed pushes to main, master, or an unnamed branch. Git commands outside T3 are not covered.",
  "26bcd8aee480544098ad0ca56453e229286b0bd6bc87c6921338fda41b3b45f3":
    "Checks the handoff format, not whether the work is complete. A failed check can stop staged installation.",
  "3428d549eedd5083ebbf0bd11b4301d6699eccc19378f76d6dd575443c68ef9f":
    "Blocks T3 direct project-file writes to Pipeline. Native writes and validation are not covered.",
};

export function hookSummary(hook: Pick<HookDefinition, "script" | "scriptSha256">): string | null {
  const actualHash = Array.from(sha256(new TextEncoder().encode(hook.script)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (actualHash !== hook.scriptSha256) return null;
  const known = KNOWN_SUMMARIES[hook.scriptSha256];
  if (known) return known;
  const match = hook.script.match(/^\s*\/\/\s*Description:\s*(\S[^\r\n]*)/i);
  const description = match?.[1]?.trim();
  return description && description.length <= 400 ? description : null;
}
