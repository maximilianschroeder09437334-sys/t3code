import type { EnvironmentId, ScopedThreadRef, ThreadContextRecord } from "@t3tools/contracts";
import { collectInlineContextIds } from "../../lib/composerContextReferences";
import type { ComposerThreadDraftState } from "../../composerDraftStore";
import type { ComposerSubmissionIntent } from "../../composer-logic";

/** Compare immutable user content without copying image bytes or upload metadata. */
export function composerDraftContentChanged(
  before: ComposerThreadDraftState | null,
  after: ComposerThreadDraftState | null,
): boolean {
  if (before === after) return false;
  if (!before || !after) return true;
  const sameIds = (left: ReadonlyArray<{ id: string }>, right: ReadonlyArray<{ id: string }>) =>
    left.length === right.length && left.every((item, index) => item.id === right[index]?.id);
  return (
    before.prompt !== after.prompt ||
    !sameIds(before.images, after.images) ||
    !sameIds(before.files, after.files) ||
    before.terminalContexts !== after.terminalContexts ||
    before.previewAnnotations !== after.previewAnnotations ||
    before.reviewComments !== after.reviewComments ||
    before.threadContexts !== after.threadContexts ||
    before.environmentContexts !== after.environmentContexts ||
    before.replyTo !== after.replyTo
  );
}

/** Attached threads the prompt still links to; replacing linked text leaves stale records. */
export function referencedThreadContexts(draft: {
  readonly prompt: string;
  readonly threadContexts: ReadonlyArray<ThreadContextRecord>;
}): ReadonlyArray<ThreadContextRecord> {
  if (draft.threadContexts.length === 0) return [];
  const referenced = new Set(collectInlineContextIds(draft.prompt));
  return draft.threadContexts.filter((record) => referenced.has(record.contextId));
}

/** Why a send waits for the user to pick a machine when no machine was chosen automatically. */
export function loadBalancingSendWarning(input: {
  readonly pending: boolean;
  readonly threadContexts: ReadonlyArray<ThreadContextRecord>;
  readonly candidateEnvironmentIds: ReadonlyArray<EnvironmentId>;
}) {
  if (input.pending) {
    return {
      title: "Checking machine resources",
      description: "Resource checks are still running. You can choose a machine in the composer.",
    };
  }
  const noMachineReadsEveryThread =
    input.threadContexts.length > 0 &&
    !input.candidateEnvironmentIds.some((environmentId) =>
      input.threadContexts.every((record) => record.environmentId === environmentId),
    );
  return {
    title: "Choose a machine to continue",
    description: noMachineReadsEveryThread
      ? "No machine can read every attached thread. Choose a machine in the composer or remove the threads."
      : "No eligible machine has available resources. Choose a machine in the composer to override.",
  };
}

/**
 * Why a multiple-model send cannot start: the server predates worktree bootstrap, or the
 * draft is not a new thread on a Git branch with at least one model.
 */
export function multipleModelSendBlock(input: {
  readonly selectionCount: number;
  readonly serverSupportsWorktreeBootstrap: boolean;
  readonly isLocalDraftThread: boolean;
  readonly isGitRepo: boolean;
  readonly branch: string | null;
}): "server-outdated" | "needs-new-git-thread" | null {
  if (!input.serverSupportsWorktreeBootstrap) return "server-outdated";
  if (
    !input.isLocalDraftThread ||
    !input.isGitRepo ||
    !input.branch ||
    input.selectionCount === 0
  ) {
    return "needs-new-git-thread";
  }
  return null;
}

/** Why a message sent over pending approvals did not go out, or null to stop quietly. */
export function approvalRedirectNotice(input: {
  readonly draftChanged: boolean;
  readonly declined: boolean;
  readonly approvalResponding: boolean;
  readonly approvalArrived: boolean;
}): string | null {
  if (input.draftChanged) {
    return input.declined
      ? "Approval declined. Your message changed, so it wasn't sent."
      : "Your message changed, so it wasn't sent.";
  }
  if (input.approvalResponding) {
    return "An approval is already being answered, so your message wasn't sent.";
  }
  if (input.declined && input.approvalArrived) {
    return "Another approval arrived, so your message wasn't sent.";
  }
  return null;
}

/**
 * The thread Home's composer opens once its send started one, since Home has no thread view of
 * its own. A failed or background send, or one the user left Home during, stays where it is.
 */
export function homeComposerSendOpenTarget(input: {
  readonly homeComposerOnly: boolean;
  readonly submissionIntent: ComposerSubmissionIntent;
  readonly turnStartSucceeded: boolean;
  readonly sentDraftThreadRef: ScopedThreadRef | null;
  readonly stillOnScreen: boolean;
}): ScopedThreadRef | null {
  if (!input.homeComposerOnly || !input.turnStartSucceeded || !input.stillOnScreen) return null;
  return input.submissionIntent === "background" ? null : input.sentDraftThreadRef;
}

/**
 * Opens the thread once its shell reaches this client. Home's view holds the sent message, and
 * the thread route mounts its own view, which would show an empty draft until the shell arrived.
 * A shell that never arrives, or a user who left Home meanwhile, leaves them where they are.
 */
export async function openThreadOnceShellArrives(input: {
  readonly waitForShell: () => Promise<boolean>;
  readonly stillOnScreen: () => boolean;
  readonly open: () => void;
}): Promise<boolean> {
  if (!(await input.waitForShell()) || !input.stillOnScreen()) return false;
  input.open();
  return true;
}
