import { ThreadId } from "@t3tools/contracts";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import { toKindScopedComposerContextId } from "@t3tools/shared/composerContextReferences";
import * as Effect from "effect/Effect";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

export interface HandoffThreadReference {
  readonly reference: string;
  readonly contextId?: string;
  readonly environmentId?: string;
  readonly threadId?: string;
}

export interface HandoffThreadState {
  readonly reference: string;
  readonly threadId: string | null;
  readonly available: boolean;
  readonly status: string | null;
  readonly activeRunId: string | null;
  readonly stopRequested: boolean;
  readonly needsUser: boolean;
}

function handoffNextStepLines(text: string): string[] {
  let fenced = false;
  let inSteps = false;
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^(?:`{3,}|~{3,})/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (/^\*\*Next steps in order\*\*$/.test(line)) {
      inSteps = true;
      continue;
    }
    if (!inSteps || !line) continue;
    if (!/^\d+\.\s/.test(line) || lines.length === 3) break;
    lines.push(line);
  }
  return lines;
}

export function handoffThreadReferences(text: string): HandoffThreadReference[] {
  const references = new Map<string, HandoffThreadReference>();
  for (const line of handoffNextStepLines(text)) {
    for (const match of line.matchAll(/\[Thread:\s*[^\]\r\n]+;\s*ref=([a-z0-9_-]{1,128})\]/gi)) {
      references.set(match[0], { reference: match[0], contextId: match[1]! });
    }
    for (const match of line.matchAll(/t3-thread:\/\/v2\/([^\s<>/)]+)\/([^\s<>)]+)/g)) {
      try {
        references.set(match[0], {
          reference: match[0],
          environmentId: decodeURIComponent(match[1]!),
          threadId: decodeURIComponent(match[2]!),
        });
      } catch {
        // Invalid escaping is left unresolved, so the hook cannot accept it as a receipt.
      }
    }
    for (const match of line.matchAll(
      /\[[^\]\r\n]+\]\((https:\/\/app\.t3\.codes\/threads\/[A-Za-z0-9_%-]+\/[A-Za-z0-9_%-]+)\)/g,
    )) {
      const parsed = parseThreadLinkHref(match[1]!);
      if (parsed?.environmentId != null) {
        references.set(match[1]!, {
          reference: match[1]!,
          environmentId: parsed.environmentId,
          threadId: parsed.threadId,
        });
      }
    }
    if (references.size >= 6) break;
  }
  return [...references.values()].slice(0, 6);
}

export function handoffIsThreadWait(text: string): boolean {
  const first = handoffNextStepLines(text)[0] ?? "";
  return (
    /^1\.\s+Codex:\s+WAIT on\s+(?:\[Thread:|\[[^\]\n]+\]\((?:<?t3-thread:|https:\/\/app\.t3\.codes\/threads\/)|<?t3-thread:)/i.test(
      first,
    ) && handoffThreadReferences(text).length > 0
  );
}

export const readHandoffThreadStates = Effect.fn("HandoffThreadRouting.readHandoffThreadStates")(
  function* (
    references: readonly HandoffThreadReference[],
    environmentId: string | undefined,
    contextThreads: readonly {
      readonly contextId: string;
      readonly threadId: string;
      readonly environmentId: string;
    }[] = [],
  ) {
    if (references.length === 0) return [];
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const index = references.some((ref) => ref.contextId !== undefined)
      ? yield* projections.listActiveShellIndex().pipe(Effect.orElseSucceed(() => []))
      : [];
    return yield* Effect.forEach(references, (ref) =>
      Effect.gen(function* () {
        const context = contextThreads.find((record) => record.contextId === ref.contextId);
        const targetEnvironment = ref.environmentId ?? context?.environmentId ?? environmentId;
        const threadId =
          ref.threadId ??
          context?.threadId ??
          index.find((entry) => toKindScopedComposerContextId("thread", entry.id) === ref.contextId)
            ?.id;
        const shell =
          threadId !== undefined &&
          environmentId !== undefined &&
          targetEnvironment === environmentId
            ? yield* projections
                .getThreadShell(ThreadId.make(threadId))
                .pipe(Effect.orElseSucceed(() => null))
            : null;
        return {
          reference: ref.reference,
          threadId: threadId ?? null,
          available: shell !== null,
          status: shell?.status ?? null,
          activeRunId: shell?.activeRunId ?? null,
          stopRequested: shell?.latestRunStopRequested === true,
          needsUser:
            shell?.pendingRuntimeRequest?.blocking !== false &&
            shell?.pendingRuntimeRequest != null,
        } satisfies HandoffThreadState;
      }),
    );
  },
);
