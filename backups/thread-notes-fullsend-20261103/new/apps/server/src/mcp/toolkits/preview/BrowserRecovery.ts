import type { ThreadId } from "@t3tools/contracts";

export interface BrowserRecoveryState {
  readonly recoveryRequired: boolean;
  readonly statusChecked: boolean;
  readonly snapshotChecked: boolean;
}

/** Tracks only explicit T3 browser actions in this server process, never page content. */
export class BrowserRecoveryTracker {
  private readonly pending = new Map<
    ThreadId,
    BrowserRecoveryState & { readonly generation: number }
  >();
  private sequence = 0;

  state(threadId: ThreadId): BrowserRecoveryState {
    const state = this.pending.get(threadId);
    return state === undefined
      ? {
          recoveryRequired: false,
          statusChecked: false,
          snapshotChecked: false,
        }
      : {
          recoveryRequired: state.recoveryRequired,
          statusChecked: state.statusChecked,
          snapshotChecked: state.snapshotChecked,
        };
  }

  generation(threadId: ThreadId): number {
    return this.pending.get(threadId)?.generation ?? 0;
  }

  failed(threadId: ThreadId): void {
    this.pending.set(threadId, {
      recoveryRequired: true,
      statusChecked: false,
      snapshotChecked: false,
      generation: ++this.sequence,
    });
  }

  checkedStatus(threadId: ThreadId, startedAtGeneration: number): void {
    const state = this.pending.get(threadId);
    if (state && state.generation === startedAtGeneration)
      this.pending.set(threadId, { ...state, statusChecked: true });
  }

  checkedSnapshot(threadId: ThreadId, startedAtGeneration: number): void {
    const state = this.pending.get(threadId);
    if (state && state.generation === startedAtGeneration)
      this.pending.set(threadId, { ...state, snapshotChecked: true });
  }

  succeeded(threadId: ThreadId, startedAtGeneration: number): void {
    if (this.generation(threadId) === startedAtGeneration) this.pending.delete(threadId);
  }
}
