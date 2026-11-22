import { scopedThreadKey } from "../lib/scopedEntities";
import { appAtomRegistry } from "./atom-registry";
import { restoredNewTaskDraftKey } from "./new-task-draft-key";
import {
  clearPendingThreadCreationOutcome,
  pendingThreadCreationOutcomesAtom,
  threadCreationSettlement,
  type ThreadCreationSettlement,
} from "./pending-thread-creation";
import { threadOutboxManager, type QueuedThreadMessage } from "./thread-outbox";
import { environmentThreadShells } from "./threads";
import { clearComposerDraft, getComposerDraftSnapshot } from "./use-composer-drafts";

/** Resolves once the outbox has delivered, rejected or dropped the creation queued for `message`. */
export function waitForThreadCreation(
  message: QueuedThreadMessage,
): Promise<ThreadCreationSettlement> {
  const shellAtom = environmentThreadShells.threadShellAtom({
    environmentId: message.environmentId,
    threadId: message.threadId,
  });
  const restoredDraftKey = restoredNewTaskDraftKey(message.messageId);
  return new Promise((resolve) => {
    const stops: Array<() => void> = [];
    let settled = false;
    const check = () => {
      if (settled) return;
      const restored = getComposerDraftSnapshot(restoredDraftKey);
      const settlement = threadCreationSettlement({
        message,
        queuedMessagesByThreadKey: appAtomRegistry.get(
          threadOutboxManager.queuedMessagesByThreadKeyAtom,
        ),
        outcomes: appAtomRegistry.get(pendingThreadCreationOutcomesAtom),
        shellExists: appAtomRegistry.get(shellAtom) !== null,
        restoredDraftHasContent: restored.text.length > 0 || restored.attachments.length > 0,
      });
      if (settlement === null) return;
      settled = true;
      for (const stop of stops) stop();
      resolve(settlement);
    };
    stops.push(
      appAtomRegistry.subscribe(threadOutboxManager.queuedMessagesByThreadKeyAtom, check),
      appAtomRegistry.subscribe(pendingThreadCreationOutcomesAtom, check),
      appAtomRegistry.subscribe(shellAtom, check),
    );
    check();
  });
}

/**
 * A rejected creation restores its message as a new draft. A sender that kept its own draft
 * drops that copy, so the message is not left in two places.
 */
export function discardRestoredThreadCreation(message: QueuedThreadMessage): void {
  clearComposerDraft(restoredNewTaskDraftKey(message.messageId));
  clearPendingThreadCreationOutcome(scopedThreadKey(message.environmentId, message.threadId));
}
