import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { deriveParkedHandoffRecovery } from "@t3tools/client-runtime/state/thread-requests";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useQuietThreadProjection, useQuietThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

export function ParkedHandoffRecovery({
  environmentId,
  selected,
  canOperate,
  environmentUnavailable,
  onReturned,
}: {
  readonly environmentId: EnvironmentId;
  readonly selected: ReturnType<typeof useQuietThreadProjection>;
  readonly canOperate: boolean;
  readonly environmentUnavailable: boolean;
  readonly onReturned: (threadId: ThreadId) => void;
}) {
  const sourceId = selected?.projection.thread.handoffSourceThreadId;
  const source = useQuietThreadProjection(
    sourceId === undefined ? null : scopeThreadRef(environmentId, sourceId),
  );
  const recovery = deriveParkedHandoffRecovery(
    selected,
    sourceId === undefined ? selected : source,
    canOperate,
  );
  const successor = useQuietThreadShell(recovery?.successorRef ?? null);
  const reverseHandoff = useOrchestrationCommand(threadEnvironment.reverseHandoff, {
    label: "return to original thread",
    reportFailure: false,
  });
  const inFlight = useRef(false);
  const [returning, setReturning] = useState(false);
  if (recovery === null) return null;

  const action = recovery.action;
  return (
    <div className="chat-content-lane">
      <div className="space-y-2 rounded-md border border-border bg-muted/40 p-3 text-sm">
        <p role="status">{recovery.reason}</p>
        <p className="break-words text-muted-foreground">
          Original: {recovery.originalTitle}
          <br />
          Replacement: {successor?.title ?? recovery.successorRef.threadId}
        </p>
        {action === null ? null : (
          <Button
            size="sm"
            variant="outline"
            disabled={environmentUnavailable || returning}
            onClick={async () => {
              if (environmentUnavailable || inFlight.current) return;
              inFlight.current = true;
              setReturning(true);
              try {
                const result = await reverseHandoff(action);
                if (AsyncResult.isSuccess(result)) {
                  onReturned(result.value);
                } else {
                  toastManager.add({
                    type: "error",
                    title: "Could not return to the original thread",
                    description: "Try again if Return is still available.",
                  });
                }
              } finally {
                inFlight.current = false;
                setReturning(false);
              }
            }}
          >
            Return to original thread
          </Button>
        )}
      </div>
    </div>
  );
}
