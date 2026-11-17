import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";

const berlinDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export const berlinDay = (at: string) => {
  const parts = berlinDate.formatToParts(DateTime.toDateUtc(DateTime.makeUnsafe(at)));
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
};

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

export interface RollupRow {
  readonly project_id: string;
  readonly day: string;
  readonly status: string;
  readonly page_id: string | null;
  readonly through_sequence: number;
  readonly synced_sequence: number;
  readonly attempts: number;
  readonly next_at: number;
}

export class NotionOutbox extends Context.Service<
  NotionOutbox,
  {
    readonly rollupsDue: (
      today: string,
      now: number,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<RollupRow>, SqlError.SqlError>;
    readonly rollupsFallback: (
      project: string,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<RollupRow>, SqlError.SqlError>;
    readonly ackRollup: (
      project: string,
      day: string,
      pageId: string,
      through: number,
    ) => Effect.Effect<boolean, SqlError.SqlError>;
    readonly fallbackRollup: (
      project: string,
      day: string,
      pageId: string | null,
    ) => Effect.Effect<void, SqlError.SqlError>;
    readonly reserveAux: (
      sequence: number,
      target: string,
      key: string,
    ) => Effect.Effect<boolean, SqlError.SqlError>;
    readonly completeAux: (
      sequence: number,
      target: string,
      key: string,
      pageId: string,
      owned: boolean,
    ) => Effect.Effect<boolean, SqlError.SqlError>;
    readonly ackAux: (
      project: string,
      sequence: number,
      pageId: string,
    ) => Effect.Effect<boolean, SqlError.SqlError>;
    readonly reviewAux: (sequence: number) => Effect.Effect<void, SqlError.SqlError>;
    readonly attachRollupPage: (
      project: string,
      day: string,
      pageId: string,
    ) => Effect.Effect<void, SqlError.SqlError>;
    readonly rollupCounts: (
      project: string,
      day: string,
      through: number,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly kind: string; readonly count: number }>,
      SqlError.SqlError
    >;
    readonly beginRollup: (
      project: string,
      day: string,
    ) => Effect.Effect<boolean, SqlError.SqlError>;
    readonly completeRollup: (
      project: string,
      day: string,
      pageId: string,
      through: number,
    ) => Effect.Effect<void, SqlError.SqlError>;
    readonly rejectRollup: (
      project: string,
      day: string,
      status: number | null,
      now: number,
      retryAfterMs: number,
    ) => Effect.Effect<void, SqlError.SqlError>;
    readonly capture: (limit: number) => Effect.Effect<ReadonlyArray<OutboxRow>, SqlError.SqlError>;
    readonly backfillRollups: (limit: number) => Effect.Effect<number, SqlError.SqlError>;
    readonly defer: (sequence: number, until: number) => Effect.Effect<void, SqlError.SqlError>;
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
  const storeRollupMembers = Effect.fn("NotionOutbox.storeRollupMembers")(function* (
    events: ReadonlyArray<{
      readonly sequence: number;
      readonly project_id: string;
      readonly at: string;
    }>,
  ) {
    if (events.length === 0) return;
    const members = events.map((event) => ({
      event_sequence: event.sequence,
      project_id: event.project_id,
      day: berlinDay(event.at),
    }));
    const inserted = yield* sql<{
      readonly event_sequence: number;
      readonly project_id: string;
      readonly day: string;
    }>`INSERT INTO notion_rollup_members ${sql.insert([members[0]!, ...members.slice(1)])} ON CONFLICT (event_sequence) DO NOTHING RETURNING event_sequence, project_id, day`;
    const groups = new Map<string, Map<string, number>>();
    for (const row of inserted) {
      const days = groups.get(row.project_id) ?? new Map<string, number>();
      days.set(row.day, Math.max(days.get(row.day) ?? 0, row.event_sequence));
      groups.set(row.project_id, days);
    }
    const rollups = [...groups].flatMap(([project_id, days]) =>
      [...days].map(([day, through_sequence]) => ({ project_id, day, through_sequence })),
    );
    if (rollups.length > 0)
      yield* sql`INSERT INTO notion_rollups ${sql.insert([rollups[0]!, ...rollups.slice(1)])} ON CONFLICT (project_id, day) DO UPDATE SET through_sequence = MAX(through_sequence, excluded.through_sequence), status = CASE WHEN status = 'done' THEN 'pending' ELSE status END`;
  });
  const backfillRollups = Effect.fn("NotionOutbox.backfillRollups")(function* (limit: number) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [cursor] = yield* sql<{
          readonly sequence: number;
        }>`SELECT sequence FROM notion_sync_cursor WHERE name = 'rollup_backfill'`;
        if (cursor === undefined) return yield* Effect.die("Missing rollup backfill cursor");
        const events = yield* sql<{
          readonly sequence: number;
          readonly project_id: string;
          readonly at: string;
        }>`SELECT e.sequence, e.project_id, e.at FROM activity_events e JOIN notion_outbox o ON o.event_sequence = e.sequence WHERE e.sequence > ${cursor.sequence} ORDER BY e.sequence LIMIT ${limit}`;
        yield* storeRollupMembers(events);
        const last = events.at(-1);
        if (last !== undefined)
          yield* sql`UPDATE notion_sync_cursor SET sequence = ${last.sequence} WHERE name = 'rollup_backfill'`;
        return events.length;
      }),
    );
  });
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
        if (last !== undefined) {
          const events = yield* sql<{
            readonly sequence: number;
            readonly project_id: string;
            readonly at: string;
          }>`SELECT sequence, project_id, at FROM activity_events WHERE sequence > ${cursor[0].sequence} AND sequence <= ${last.event_sequence} ORDER BY sequence`;
          yield* storeRollupMembers(events);
          yield* sql`UPDATE notion_sync_cursor SET sequence = ${last.event_sequence} WHERE name = 'activity'`;
        }
        return ordered;
      }),
    );
  });
  const due = Effect.fn("NotionOutbox.due")(function* (now: number, limit: number) {
    return yield* sql<OutboxRow>`WITH heads AS (
      SELECT e.project_id, e.feature_key, MIN(o.event_sequence) AS sequence
      FROM notion_outbox o INDEXED BY notion_outbox_due JOIN activity_events e ON e.sequence = o.event_sequence
      WHERE o.status IN ('pending', 'fallback', 'creating', 'appending') AND e.feature_key IS NOT NULL
      GROUP BY e.project_id, e.feature_key
    ) SELECT o.* FROM notion_outbox o JOIN activity_events e ON e.sequence = o.event_sequence
      LEFT JOIN heads h ON h.project_id = e.project_id AND h.feature_key = e.feature_key
      WHERE o.status = 'pending' AND o.next_at <= ${now} AND (e.feature_key IS NULL OR h.sequence = o.event_sequence)
      ORDER BY o.event_sequence LIMIT ${limit}`;
  });
  const defer = Effect.fn("NotionOutbox.defer")(function* (sequence: number, until: number) {
    yield* sql`UPDATE notion_outbox SET next_at = MAX(next_at, ${until}) WHERE event_sequence = ${sequence} AND status = 'pending'`;
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
    yield* sql`UPDATE notion_outbox SET status = 'fallback', last_error = CASE WHEN last_error LIKE 'aux|%' THEN last_error ELSE 'uncertain remote write' END WHERE status IN ('creating', 'appending')`;
    yield* sql`UPDATE notion_rollups SET status = CASE status WHEN 'creating' THEN 'fallback' ELSE 'pending' END WHERE status IN ('creating', 'updating')`;
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
        const aux = row.last_error?.match(/^aux\|([^|]+)\|(.+)$/);
        if (aux && nextStatus === "pending") {
          const marker = `pending:${sequence}`;
          yield* sql`DELETE FROM notion_sync_pages WHERE target = ${aux[1]!} AND page_key = ${aux[2]!} AND page_id = ${marker}`;
        }
        const reason =
          aux && nextStatus === "fallback"
            ? row.last_error
            : ambiguous
              ? "uncertain remote write"
              : String(status ?? "network");
        yield* sql`UPDATE notion_outbox SET status = ${nextStatus}, attempts = ${decision.attempts}, next_at = ${nextAt}, last_error = ${reason} WHERE event_sequence = ${sequence}`;
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
        }>`SELECT e.id, e.feature_key FROM activity_events e JOIN notion_outbox o ON o.event_sequence = e.sequence WHERE e.project_id = ${project} AND e.sequence = ${sequence} AND o.status = 'fallback' AND (o.last_error IS NULL OR o.last_error NOT LIKE 'aux|%')`;
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
  const reserveAux = Effect.fn("NotionOutbox.reserveAux")(function* (
    sequence: number,
    target: string,
    key: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [row] =
          yield* sql<OutboxRow>`SELECT * FROM notion_outbox WHERE event_sequence = ${sequence} AND status = 'pending'`;
        if (row === undefined) return false;
        const marker = `pending:${sequence}`;
        const inserted = yield* sql<{
          readonly page_id: string;
        }>`INSERT INTO notion_sync_pages (target, page_key, page_id) VALUES (${target}, ${key}, ${marker}) ON CONFLICT (target, page_key) DO NOTHING RETURNING page_id`;
        if (inserted.length === 0) return false;
        yield* sql`UPDATE notion_outbox SET status = 'creating', last_error = ${`aux|${target}|${key}`} WHERE event_sequence = ${sequence} AND status = 'pending'`;
        return true;
      }),
    );
  });
  const completeAux = Effect.fn("NotionOutbox.completeAux")(function* (
    sequence: number,
    target: string,
    key: string,
    pageId: string,
    owned: boolean,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const reason = `aux|${target}|${key}`;
        const [row] =
          yield* sql<OutboxRow>`SELECT * FROM notion_outbox WHERE event_sequence = ${sequence} AND status IN ('creating', 'fallback') AND last_error = ${reason}`;
        if (row === undefined) return false;
        const marker = `pending:${sequence}`;
        const changed = yield* sql<{
          readonly page_id: string;
        }>`UPDATE notion_sync_pages SET page_id = ${pageId} WHERE target = ${target} AND page_key = ${key} AND page_id = ${marker} RETURNING page_id`;
        if (changed.length === 0) return false;
        if (owned)
          yield* sql`INSERT INTO notion_sync_pages (target, page_key, page_id) VALUES (${target}, ${`owned:${key}`}, ${pageId}) ON CONFLICT (target, page_key) DO NOTHING`;
        yield* sql`UPDATE notion_outbox SET status = 'pending', last_error = NULL, next_at = 0 WHERE event_sequence = ${sequence}`;
        return true;
      }),
    );
  });
  const ackAux = Effect.fn("NotionOutbox.ackAux")(function* (
    project: string,
    sequence: number,
    pageId: string,
  ) {
    const [row] = yield* sql<{
      readonly last_error: string | null;
    }>`SELECT o.last_error FROM notion_outbox o JOIN activity_events e ON e.sequence = o.event_sequence WHERE o.event_sequence = ${sequence} AND o.status = 'fallback' AND e.project_id = ${project}`;
    const match = row?.last_error?.match(/^aux\|([^|]+)\|(.+)$/);
    if (match === undefined || match === null) return false;
    return yield* completeAux(sequence, match[1]!, match[2]!, pageId, false);
  });
  const reviewAux = Effect.fn("NotionOutbox.reviewAux")(function* (sequence: number) {
    yield* sql`UPDATE notion_outbox SET status = 'fallback' WHERE event_sequence = ${sequence} AND status = 'creating' AND last_error LIKE 'aux|%'`;
  });
  const attachRollupPage = Effect.fn("NotionOutbox.attachRollupPage")(function* (
    project: string,
    day: string,
    pageId: string,
  ) {
    yield* sql`UPDATE notion_rollups SET page_id = ${pageId} WHERE project_id = ${project} AND day = ${day} AND status = 'pending' AND page_id IS NULL`;
  });
  const rollupsDue = Effect.fn("NotionOutbox.rollupsDue")(function* (
    today: string,
    now: number,
    limit: number,
  ) {
    return yield* sql<RollupRow>`SELECT * FROM notion_rollups WHERE day < ${today} AND status = 'pending' AND next_at <= ${now} ORDER BY day, project_id LIMIT ${limit}`;
  });
  const rollupCounts = Effect.fn("NotionOutbox.rollupCounts")(function* (
    project: string,
    day: string,
    through: number,
  ) {
    return yield* sql<{
      readonly kind: string;
      readonly count: number;
    }>`SELECT e.kind, COUNT(*) AS count FROM notion_rollup_members m JOIN activity_events e ON e.sequence = m.event_sequence WHERE m.project_id = ${project} AND m.day = ${day} AND m.event_sequence <= ${through} GROUP BY e.kind ORDER BY e.kind`;
  });
  const rollupsFallback = Effect.fn("NotionOutbox.rollupsFallback")(function* (
    project: string,
    limit: number,
  ) {
    return yield* sql<RollupRow>`SELECT * FROM notion_rollups WHERE project_id = ${project} AND status = 'fallback' ORDER BY day LIMIT ${limit}`;
  });
  const ackRollup = Effect.fn("NotionOutbox.ackRollup")(function* (
    project: string,
    day: string,
    pageId: string,
    through: number,
  ) {
    const rows =
      yield* sql<RollupRow>`UPDATE notion_rollups SET page_id = ${pageId}, status = CASE WHEN through_sequence > ${through} THEN 'pending' ELSE 'done' END, synced_sequence = ${through}, next_at = 0 WHERE project_id = ${project} AND day = ${day} AND status = 'fallback' AND ${through} > synced_sequence AND ${through} <= through_sequence AND EXISTS (SELECT 1 FROM notion_rollup_members WHERE project_id = ${project} AND day = ${day} AND event_sequence = ${through}) RETURNING *`;
    return rows.length > 0;
  });
  const fallbackRollup = Effect.fn("NotionOutbox.fallbackRollup")(function* (
    project: string,
    day: string,
    pageId: string | null,
  ) {
    yield* sql`UPDATE notion_rollups SET status = 'fallback', page_id = ${pageId} WHERE project_id = ${project} AND day = ${day} AND status = 'pending'`;
  });
  const beginRollup = Effect.fn("NotionOutbox.beginRollup")(function* (
    project: string,
    day: string,
  ) {
    const rows =
      yield* sql<RollupRow>`UPDATE notion_rollups SET status = CASE WHEN page_id IS NULL THEN 'creating' ELSE 'updating' END WHERE project_id = ${project} AND day = ${day} AND status = 'pending' RETURNING *`;
    return rows.length > 0;
  });
  const completeRollup = Effect.fn("NotionOutbox.completeRollup")(function* (
    project: string,
    day: string,
    pageId: string,
    through: number,
  ) {
    yield* sql`UPDATE notion_rollups SET page_id = ${pageId}, synced_sequence = ${through}, status = CASE WHEN through_sequence > ${through} THEN 'pending' ELSE 'done' END WHERE project_id = ${project} AND day = ${day} AND status IN ('creating', 'updating')`;
  });
  const rejectRollup = Effect.fn("NotionOutbox.rejectRollup")(function* (
    project: string,
    day: string,
    status: number | null,
    now: number,
    retryAfterMs: number,
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const [row] =
          yield* sql<RollupRow>`SELECT * FROM notion_rollups WHERE project_id = ${project} AND day = ${day} AND status IN ('pending', 'creating', 'updating')`;
        if (row === undefined) return;
        const decision = retryDecision(row.attempts, status, now);
        const ambiguous = row.status === "creating" && (status === null || status >= 500);
        const nextStatus = ambiguous ? "fallback" : decision.status;
        const nextAt = nextStatus === "pending" ? Math.max(decision.nextAt, now + retryAfterMs) : 0;
        yield* sql`UPDATE notion_rollups SET status = ${nextStatus}, attempts = ${decision.attempts}, next_at = ${nextAt} WHERE project_id = ${project} AND day = ${day}`;
      }),
    );
  });
  return NotionOutbox.of({
    rollupsDue,
    rollupsFallback,
    ackRollup,
    fallbackRollup,
    reserveAux,
    completeAux,
    ackAux,
    reviewAux,
    attachRollupPage,
    rollupCounts,
    beginRollup,
    completeRollup,
    rejectRollup,
    capture,
    backfillRollups,
    defer,
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
