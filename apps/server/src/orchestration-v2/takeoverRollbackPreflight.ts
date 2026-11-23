/**
 * Rollback to .23 (plan-b-r6 §8) needs no live migrated child, pending forward, open obligation or
 * live attempt: .23 has no forward handler or owner. Read-only SQL, so the install gate can run it
 * on a copy of the state database (`scripts/takeover-rollback-preflight.ts`).
 */

/**
 * Open obligations: each `transferredTo.forwards` attempt whose child's current owner anchor has no
 * result from that run or a later one. Closure is the owner's record itself, so a `failed` or
 * `succeeded` outbox row does not close one. Shared with `ProjectionStore.getTakeoverObligations`.
 */
export const TAKEOVER_OBLIGATIONS_SQL = `
  SELECT task.thread_id AS source_thread_id, task.subagent_id AS source_task_id,
    task.child_thread_id AS child_thread_id, forward.value AS attempt_run_id
  FROM (
    SELECT * FROM orchestration_v2_projection_subagents
    WHERE child_thread_id IS NOT NULL
      AND CASE WHEN json_valid(payload_json)
        THEN json_type(payload_json, '$.transferredTo.forwards') = 'array'
        ELSE 0 END
  ) AS task
  JOIN json_each(task.payload_json, '$.transferredTo.forwards') AS forward
  JOIN orchestration_v2_projection_runs AS attempt
    ON attempt.run_id = forward.value AND attempt.thread_id = task.child_thread_id
  JOIN orchestration_v2_projection_threads AS child
    ON child.thread_id = task.child_thread_id
  LEFT JOIN orchestration_v2_projection_subagents AS anchor
    ON anchor.subagent_id = json_extract(child.payload_json, '$.ownership.anchorTaskId')
    AND anchor.thread_id = json_extract(child.payload_json, '$.ownership.ownerThreadId')
  LEFT JOIN orchestration_v2_projection_runs AS recorded
    ON recorded.run_id = json_extract(anchor.payload_json, '$.resultRunId')
    AND recorded.thread_id = child.thread_id
  WHERE NOT (
    json_extract(anchor.payload_json, '$.result') IS NOT NULL
    AND recorded.ordinal IS NOT NULL
    AND recorded.ordinal >= attempt.ordinal
  )
  ORDER BY task.thread_id, task.subagent_id, attempt.ordinal
`;

/**
 * Migrated children still live: a run not ended, or the owner's anchor task not ended. Deleted
 * children are skipped (deletion already disposed their work).
 */
const LIVE_MIGRATED_CHILDREN_SQL = `
  SELECT child.thread_id AS thread_id,
    json_extract(child.payload_json, '$.ownership.ownerThreadId') AS owner_thread_id,
    (SELECT group_concat(run.run_id || ':' || run.status) FROM orchestration_v2_projection_runs run
      WHERE run.thread_id = child.thread_id
        AND run.status IN ('preparing', 'queued', 'starting', 'running', 'waiting')) AS live_runs,
    anchor.status AS anchor_status
  FROM orchestration_v2_projection_threads child
  LEFT JOIN orchestration_v2_projection_subagents anchor
    ON anchor.subagent_id = json_extract(child.payload_json, '$.ownership.anchorTaskId')
    AND anchor.thread_id = json_extract(child.payload_json, '$.ownership.ownerThreadId')
  WHERE child.deleted_at IS NULL
    AND CASE WHEN json_valid(child.payload_json)
      THEN json_extract(child.payload_json, '$.ownership.ownerThreadId') END IS NOT NULL
    AND (
      EXISTS (
        SELECT 1 FROM orchestration_v2_projection_runs run
        WHERE run.thread_id = child.thread_id
          AND run.status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
      )
      OR anchor.status IN ('idle', 'pending', 'running', 'waiting')
    )
  ORDER BY child.thread_id
`;

/** `takeover.forward` rows (re-armed copies included) not settled yet. */
const PENDING_FORWARDS_SQL = `
  SELECT effect_id, status FROM orchestration_v2_effect_outbox
  WHERE effect_type = 'takeover.forward' AND status IN ('pending', 'running')
  ORDER BY effect_id
`;

/** Takeover attempts that may still commit: `attempting` before their deadline. */
const ATTEMPTING_TAKEOVERS_SQL = `
  SELECT thread_id, json_extract(payload_json, '$.continuedBy.deadlineAt') AS deadline_at
  FROM orchestration_v2_projection_threads
  WHERE CASE WHEN json_valid(payload_json)
    THEN json_extract(payload_json, '$.continuedBy.state') END = 'attempting'
    AND julianday(json_extract(payload_json, '$.continuedBy.deadlineAt')) > julianday(?)
  ORDER BY thread_id
`;

export type TakeoverRollbackBlocker =
  | {
      readonly kind: "live_migrated_child";
      readonly childThreadId: string;
      readonly ownerThreadId: string;
      readonly liveRuns: string | null;
      readonly anchorStatus: string | null;
    }
  | { readonly kind: "pending_forward"; readonly effectId: string; readonly status: string }
  | {
      readonly kind: "open_obligation";
      readonly sourceThreadId: string;
      readonly sourceTaskId: string;
      readonly childThreadId: string;
      readonly attemptRunId: string;
    }
  | {
      readonly kind: "takeover_attempting";
      readonly threadId: string;
      readonly deadlineAt: string;
    };

/** The part of `node:sqlite`'s DatabaseSync the preflight uses. */
export interface TakeoverRollbackDatabase {
  readonly prepare: (sql: string) => {
    readonly all: (...params: ReadonlyArray<string>) => ReadonlyArray<unknown>;
  };
}

/** Every reason the state at `database` may not roll back to .23 yet; empty means allowed. */
export function takeoverRollbackBlockers(
  database: TakeoverRollbackDatabase,
  /** ISO time; an `attempting` takeover blocks until its deadline passes. */
  nowIso: string,
): ReadonlyArray<TakeoverRollbackBlocker> {
  const rows = <Row>(sql: string, ...params: ReadonlyArray<string>) =>
    database.prepare(sql).all(...params) as ReadonlyArray<Row>;
  return [
    ...rows<{
      thread_id: string;
      owner_thread_id: string;
      live_runs: string | null;
      anchor_status: string | null;
    }>(LIVE_MIGRATED_CHILDREN_SQL).map((row): TakeoverRollbackBlocker => ({
      kind: "live_migrated_child",
      childThreadId: row.thread_id,
      ownerThreadId: row.owner_thread_id,
      liveRuns: row.live_runs,
      anchorStatus: row.anchor_status,
    })),
    ...rows<{ effect_id: string; status: string }>(PENDING_FORWARDS_SQL).map(
      (row): TakeoverRollbackBlocker => ({
        kind: "pending_forward",
        effectId: row.effect_id,
        status: row.status,
      }),
    ),
    ...rows<{
      source_thread_id: string;
      source_task_id: string;
      child_thread_id: string;
      attempt_run_id: string;
    }>(TAKEOVER_OBLIGATIONS_SQL).map((row): TakeoverRollbackBlocker => ({
      kind: "open_obligation",
      sourceThreadId: row.source_thread_id,
      sourceTaskId: row.source_task_id,
      childThreadId: row.child_thread_id,
      attemptRunId: row.attempt_run_id,
    })),
    ...rows<{ thread_id: string; deadline_at: string }>(ATTEMPTING_TAKEOVERS_SQL, nowIso).map(
      (row): TakeoverRollbackBlocker => ({
        kind: "takeover_attempting",
        threadId: row.thread_id,
        deadlineAt: row.deadline_at,
      }),
    ),
  ];
}
