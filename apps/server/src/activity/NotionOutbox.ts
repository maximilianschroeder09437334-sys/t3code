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
    readonly fail: (
      sequence: number,
      httpStatus: number | null,
      now: number,
    ) => Effect.Effect<void, SqlError.SqlError>;
    readonly ack: (sequence: number, pageId: string) => Effect.Effect<boolean, SqlError.SqlError>;
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
  return NotionOutbox.of({ capture, due, fallback, fail, ack });
});
export const layer = Layer.effect(NotionOutbox, make);
