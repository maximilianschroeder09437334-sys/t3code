/** Extract the owner of the first explicit handoff step without interpreting its meaning. */
export function handoffFirstStepOwner(text: string): "codex" | "maxi" | "other" | null {
  return firstStep(text)?.owner ?? null;
}

/** The first step is agent-owned work in this thread, not a wait or another thread's task. */
export function handoffFirstStepIsOwnWork(text: string): boolean {
  const step = firstStep(text);
  return step?.owner === "codex" && !/^(?:\[|WAIT\b)/i.test(step.body);
}

// "T3" is the agent owner label in T3-hosted reports; "codex" stays the payload value hooks match.
const AGENT_OWNERS = new Set(["codex", "t3"]);

function firstStep(text: string): { owner: "codex" | "maxi" | "other"; body: string } | null {
  let inFence = false;
  let inSteps = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^(?:`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!inSteps) {
      if (/^(?:#{1,6}\s*)?(?:\*\*)?next steps in order(?:\*\*)?\s*:?\s*$/i.test(line)) {
        inSteps = true;
      }
      continue;
    }
    if (!line) continue;
    const step = /^(?:1[.)]|[-*])\s+(?:\*\*)?([^:\n*]+?)(?:\*\*)?:(?:\*\*)?(?:\s|$)/.exec(line);
    if (!step) return null;
    const owner = step[1]!.trim().toLowerCase();
    return {
      owner: AGENT_OWNERS.has(owner) ? "codex" : owner === "maxi" ? "maxi" : "other",
      body: line.slice(step[0].length).trim(),
    };
  }
  return null;
}

/** Conservatively leave a handoff alone when it explicitly asks the user to act. */
export function handoffNeedsUser(text: string): boolean {
  let inFence = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^(?:`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const prose = line.replace(/https?:\/\/\S+/g, "");
    if (prose.includes("?")) return true;
    if (
      /\b(?:waiting for|awaiting|needs?|requires?|after)\s+(?:your|the user's|user's|maxi(?:'s)?|you\b)/i.test(
        prose,
      )
    )
      return true;
    if (
      /\b(?:please\s+(?:provide|approve|confirm|select|choose)|(?:needs?|requires?|awaiting|after)\s+(?:approval|confirmation|input|a decision)|approval\s+(?:is\s+)?required|requires?\s+user\s+approval|blocked\s+(?:on|by|pending)\s+(?:your\s+|user\s+)?(?:approval|confirmation|input|a decision))\b/i.test(
        prose,
      )
    )
      return true;
  }
  return false;
}

/** A pause applies when it is the first requested action, not after useful work. */
export function userRequestedPauseOrWait(text: string): boolean {
  const firstAction = text.trim().split(/\s*(?:,\s*then\b|\bthen\b|;|\r?\n)/i, 1)[0] ?? "";
  if (
    /^(?:please\s+)?(?:stop|pause|wait|hold)\b|^(?:please\s+)?(?:do not|don't)\s+(?:start|continue|proceed|implement|change|edit|write)\b/i.test(
      firstAction.trim(),
    )
  )
    return true;
  return /\b(?:so|therefore)\s+(?:please\s+)?(?:stop|pause|hold)\s+(?:now|here|for now)\b/i.test(
    text,
  );
}

/** Full Stop permits staged preparation but holds staged-file installation. */
export function userRequestedFullStopHold(text: string): boolean {
  return /\bfull[ -]stop\b/i.test(text);
}
