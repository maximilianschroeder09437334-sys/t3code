import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";

export const retryDecision = (attempts: number, status: number | null, now: number) => {
  const nextAttempt = attempts + 1;
  return status === 401 || status === 403 || status === 404 || nextAttempt >= 5
    ? { status: "fallback" as const, attempts: nextAttempt, nextAt: 0 }
    : {
        status: "pending" as const,
        attempts: nextAttempt,
        nextAt: now + Math.min(60000, 1000 * 2 ** (nextAttempt - 1)),
      };
};

export interface OutboxRow {
  readonly event_sequence: number;
  readonly status: string;
  readonly attempts: number;
  readonly next_at: number;
  readonly page_id: string | null;
  readonly block_id: string | null;
  readonly last_error: string | null;
}

export class NotionOutbox extends Context.Service<
  NotionOutbox,
  {
    readonly capture: (limit: number) => Effect.Effect<ReadonlyArray<OutboxRow>, SqlError.SqlError>;
    readonly due: (
      now: number,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<OutboxRow>, SqlError.SqlError>;
    readonly fallback: (
      limit: number,
    ) => Effect.Effect<ReadonlyArray<OutboxRow>, SqlError.SqlError>;
    readonly fallbackForProject: (
      project: string,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<OutboxRow>, SqlError.SqlError>;
    readonly ackForProject: (
      project: string,
      sequence: number,
      target: string,
      pageId: string,
      blockId: string,
    ) => Effect.Effect<boolean, SqlError.SqlError>;
    readonly fail: (
      sequence: number,
      httpStatus: number | null,
      now: number,
    ) => Effect.Effect<void, SqlError.SqlError>;
    readonly ack: (sequence: number, pageId: string) => Effect.Effect<boolean, SqlError.SqlError>;
    readonly rememberPage: (
      target: string,
      key: string,
      pageId: string,
    ) => Effect.Effect<string, SqlError.SqlError>;
    readonly getPage: (
      target: string,
      key: string,
    ) => Effect.Effect<string | null, SqlError.SqlError>;
    readonly begin: (
      sequence: number,
      phase: "creating" | "appending",
    ) => Effect.Effect<boolean, SqlError.SqlError>;
    readonly recover: () => Effect.Effect<void, SqlError.SqlError>;
    readonly attachPage: (
      sequence: number,
      pageId: string,
    ) => Effect.Effect<void, SqlError.SqlError>;
    readonly rejected: (
      sequence: number,
      status: number | null,
      now: number,
      retryAfterMs: number,
    ) => Effect.Effect<void, SqlError.SqlError>;
    readonly created: (
      sequence: number,
      target: string,
      key: string,
      pageId: string,
    ) => Effect.Effect<void, SqlError.SqlError>;
    readonly completed: (
      sequence: number,
      blockId: string,
    ) => Effect.Effect<boolean, SqlError.SqlError>;
  }
>()("t3/activity/NotionOutbox") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const capture = Effect.fn("NotionOutbox.capture")(function* (limit: number) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const cursor = yield* sql<{
          readonly sequence: number;
        }>`SELECT sequence FROM notion_sync_cursor WHERE name = 'activity'`;
        if (cursor[0] === undefined) return yield* Effect.die("Missing Notion outbox cursor");
        const rows = yield* sql<OutboxRow>`INSERT INTO notion_outbox (event_sequence)
        SELECT sequence FROM activity_events WHERE sequence > ${cursor[0].sequence}
        ORDER BY sequence ASC LIMIT ${limit} RETURNING *`;
        const ordered = [...rows].sort((a, b) => a.event_sequence - b.event_sequence);
        const last = ordered.at(-1);
        if (last !== undefined)
          yield* sql`UPDATE notion_sync_cursor SET sequence = ${last.event_sequence} WHERE name = 'activity'`;
        return ordered;
      }),
    );
  });
  const due = Effect.fn("NotionOutbox.due")(function* (now: number, limit: number) {
    return yield* sql<OutboxRow>`SELECT * FROM notion_outbox WHERE status = 'pending' AND next_at <= ${now} ORDER BY event_sequence LIMIT ${limit}`;
  });
  const fallback = Effect.fn("NotionOutbox.fallback")(function* (limit: number) {
    return yield* sql<OutboxRow>`SELECT * FROM notion_outbox WHERE status = 'fallback' ORDER BY event_sequence LIMIT ${limit}`;
  });
  const fallbackForProject = Effect.fn("NotionOutbox.fallbackForProject")(function* (
    project: string,
    limit: number,
  ) {
    return yield* sql<OutboxRow>`SELECT o.* FROM notion_outbox o JOIN activity_events e ON e.sequence = o.event_sequence WHERE o.status = 'fallback' AND e.project_id = ${project} ORDER BY o.event_sequence LIMIT ${limit}`;
  });
  const fail = Effect.fn("NotionOutbox.fail")(function* (
    sequence: number,
    httpStatus: number | null,
    now: number,
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const [row] =
          yield* sql<OutboxRow>`SELECT * FROM notion_outbox WHERE event_sequence = ${sequence} AND status = 'pending'`;
        if (row === undefined) return;
        const next = retryDecision(row.attempts, httpStatus, now);
        yield* sql`UPDATE notion_outbox SET status = ${next.status}, attempts = ${next.attempts}, next_at = ${next.nextAt}, last_error = ${httpStatus === null ? "network" : String(httpStatus)} WHERE event_sequence = ${sequence} AND status = 'pending'`;
      }),
    );
  });
  const ack = Effect.fn("NotionOutbox.ack")(function* (sequence: number, pageId: string) {
    const rows =
      yield* sql<OutboxRow>`UPDATE notion_outbox SET status = 'done', page_id = ${pageId} WHERE event_sequence = ${sequence} AND status = 'fallback' RETURNING *`;
    return rows.length > 0;
  });
  const getPage = Effect.fn("NotionOutbox.getPage")(function* (target: string, key: string) {
    const [row] = yield* sql<{
      readonly page_id: string;
    }>`SELECT page_id FROM notion_sync_pages WHERE target = ${target} AND page_key = ${key}`;
    return row?.page_id ?? null;
  });
  const rememberPage = Effect.fn("NotionOutbox.rememberPage")(function* (
    target: string,
    key: string,
    pageId: string,
  ) {
    yield* sql`INSERT INTO notion_sync_pages (target, page_key, page_id) VALUES (${target}, ${key}, ${pageId}) ON CONFLICT (target, page_key) DO NOTHING`;
    const stored = yield* getPage(target, key);
    if (stored === null) return yield* Effect.die("Notion page mapping was not persisted");
    return stored;
  });
  const begin = Effect.fn("NotionOutbox.begin")(function* (
    sequence: number,
    phase: "creating" | "appending",
  ) {
    const rows =
      yield* sql<OutboxRow>`UPDATE notion_outbox SET status = ${phase} WHERE event_sequence = ${sequence} AND status = 'pending' RETURNING *`;
    return rows.length > 0;
  });
  const recover = Effect.fn("NotionOutbox.recover")(function* () {
    yield* sql`UPDATE notion_outbox SET status = 'fallback', last_error = 'uncertain remote write' WHERE status IN ('creating', 'appending')`;
  });
  const attachPage = Effect.fn("NotionOutbox.attachPage")(function* (
    sequence: number,
    pageId: string,
  ) {
    yield* sql`UPDATE notion_outbox SET page_id = ${pageId} WHERE event_sequence = ${sequence} AND status = 'pending'`;
  });
  const rejected = Effect.fn("NotionOutbox.rejected")(function* (
    sequence: number,
    status: number | null,
    now: number,
    retryAfterMs: number,
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const [row] =
          yield* sql<OutboxRow>`SELECT * FROM notion_outbox WHERE event_sequence = ${sequence} AND status IN ('pending', 'creating', 'appending')`;
        if (row === undefined) return;
        const ambiguous = row.status !== "pending" && (status === null || status >= 500);
        const decision = retryDecision(row.attempts, status, now);
        const nextStatus = ambiguous ? "fallback" : decision.status;
        const nextAt = nextStatus === "pending" ? Math.max(decision.nextAt, now + retryAfterMs) : 0;
        yield* sql`UPDATE notion_outbox SET status = ${nextStatus}, attempts = ${decision.attempts}, next_at = ${nextAt}, last_error = ${ambiguous ? "uncertain remote write" : String(status ?? "network")} WHERE event_sequence = ${sequence}`;
      }),
    );
  });
  const created = Effect.fn("NotionOutbox.created")(function* (
    sequence: number,
    target: string,
    key: string,
    pageId: string,
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const [row] =
          yield* sql<OutboxRow>`SELECT * FROM notion_outbox WHERE event_sequence = ${sequence} AND status = 'creating'`;
        if (row === undefined) return;
        const stored = yield* rememberPage(target, key, pageId);
        if (stored !== pageId) return yield* Effect.die("Conflicting Notion page mapping");
        yield* sql`UPDATE notion_outbox SET page_id = ${pageId}, status = 'pending' WHERE event_sequence = ${sequence} AND status = 'creating'`;
      }),
    );
  });
  const completed = Effect.fn("NotionOutbox.completed")(function* (
    sequence: number,
    blockId: string,
  ) {
    const rows =
      yield* sql<OutboxRow>`UPDATE notion_outbox SET status = 'done', block_id = ${blockId} WHERE event_sequence = ${sequence} AND status = 'appending' RETURNING *`;
    return rows.length > 0;
  });
  const ackForProject = Effect.fn("NotionOutbox.ackForProject")(function* (
    project: string,
    sequence: number,
    target: string,
    pageId: string,
    blockId: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [event] = yield* sql<{
          readonly id: string;
          readonly feature_key: string | null;
        }>`SELECT e.id, e.feature_key FROM activity_events e JOIN notion_outbox o ON o.event_sequence = e.sequence WHERE e.project_id = ${project} AND e.sequence = ${sequence} AND o.status = 'fallback'`;
        if (event === undefined) return false;
        const key =
          event.feature_key === null
            ? `event:${event.id}`
            : `feature:${project}:${event.feature_key}`;
        const stored = yield* rememberPage(target, key, pageId);
        if (stored !== pageId) return false;
        const rows =
          yield* sql<OutboxRow>`UPDATE notion_outbox SET status = 'done', page_id = ${pageId}, block_id = ${blockId} WHERE event_sequence = ${sequence} AND status = 'fallback' RETURNING *`;
        return rows.length > 0;
      }),
    );
  });
  return NotionOutbox.of({
    capture,
    due,
    fallback,
    fallbackForProject,
    fail,
    ack,
    getPage,
    rememberPage,
    begin,
    recover,
    attachPage,
    rejected,
    created,
    completed,
    ackForProject,
  });
});
export const layer = Layer.effect(NotionOutbox, make);
