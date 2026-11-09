import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { hooksRuntime } from "~/state/hooks";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";

export function HookRuntimeStatus({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const query = useEnvironmentQuery(hooksRuntime({ environmentId, input: { projectId } }));
  return (
    <details className="px-4 py-3">
      <summary className="cursor-pointer text-sm font-medium">
        Timers and recovery incidents
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        <div>
          <Button variant="outline" size="sm" onClick={query.refresh}>
            Refresh status
          </Button>
        </div>
        {query.error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {query.error}
          </p>
        ) : null}
        {query.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading runtime state...
          </p>
        ) : null}
        {query.data !== null ? (
          <>
            {query.data.leases.length === 0 && query.data.incidents.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No timers or incidents recorded for this project.
              </p>
            ) : null}
            {query.data.leases.map((lease) => (
              <div key={lease.id} className="flex flex-col gap-1 text-sm">
                <p>
                  Computer use: {lease.status}; reminder {lease.notification}.
                </p>
                <p className="text-muted-foreground">
                  Estimate ends {new Date(lease.expiresAt).toLocaleString()}. Native release:{" "}
                  {lease.backendEnded ? "reported acknowledged" : "not proven"}.
                </p>
              </div>
            ))}
            {query.data.incidents.map((incident) => (
              <div key={incident.id} className="flex flex-col gap-1 text-sm">
                <p>
                  {incident.event.replaceAll("_", " ")}: {incident.status}
                </p>
                <p className="whitespace-pre-wrap text-muted-foreground">{incident.summary}</p>
                <p className="text-xs text-muted-foreground">
                  {incident.attempts} repair attempts; updated{" "}
                  {new Date(incident.updatedAt).toLocaleString()}.
                </p>
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              Checked {new Date(query.data.checkedAt).toLocaleString()}.
            </p>
          </>
        ) : null}
      </div>
    </details>
  );
}
