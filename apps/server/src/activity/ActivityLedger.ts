import {
  ActivityEvent,
  ActivityEventDraft,
  ActivityLedgerError,
  type ActivityCheckIn,
  type ActivityCheckInGetResult,
  type ActivityListInput,
  type ActivitySubscribeInput,
} from "@t3tools/contracts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

export interface ActivityAppendInput extends ActivityEventDraft {
  /** Same key, same event: replayed effects and retried calls append once. */
  readonly key: string;
}

export interface ActivityAppendResult {
  readonly event: ActivityEvent;
  readonly created: boolean;
}

const SINCE_CHECK_IN_LIMIT = 200;
const BACKFILL_LIMIT = 500;

export class ActivityLedger extends Context.Service<
  ActivityLedger,
  {
    readonly append: (
      input: ActivityAppendInput,
    ) => Effect.Effect<ActivityAppendResult, ActivityLedgerError>;
    readonly list: (
      query: ActivityListInput,
    ) => Effect.Effect<ReadonlyArray<ActivityEvent>, ActivityLedgerError>;
    /** New events only, after `afterSequence` when given; history is never replayed past that. */
    readonly stream: (
      filter: ActivitySubscribeInput,
    ) => Stream.Stream<ActivityEvent, ActivityLedgerError>;
    readonly getCheckIn: (
      userKey: string,
    ) => Effect.Effect<ActivityCheckIn | null, ActivityLedgerError>;
    readonly sinceCheckIn: (
      userKey: string,
    ) => Effect.Effect<ActivityCheckInGetResult, ActivityLedgerError>;
    readonly markSeen: (
      userKey: string,
      seenSequence?: number,
    ) => Effect.Effect<ActivityCheckIn, ActivityLedgerError>;
  }
>()("t3/activity/ActivityLedger") {}

interface Row {
  readonly sequence: number;
  readonly id: string;
  readonly at: string;
  readonly kind: string;
  readonly project_id: string;
  readonly thread_id: string;
  readonly feature_key: string | null;
  readonly summary: string;
  readonly details_json: string;
}

const { featureTitle, links, next, tests } = ActivityEventDraft.fields;
const Details = Schema.fromJsonString(
  Schema.toCodecJson(Schema.Struct({ featureTitle, links, next, tests })),
);
const encodeDetails = Schema.encodeEffect(Details);
const decodeEvent = Schema.decodeUnknownEffect(ActivityEvent);
const decodeDraft = Schema.decodeUnknownEffect(ActivityEventDraft);
const decodeDetails = Schema.decodeUnknownEffect(Details);

const storage = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tapError((cause) => Effect.logWarning("Activity ledger storage failed", { cause })),
    Effect.mapError(
      () =>
        new ActivityLedgerError({ message: "The activity ledger could not be read or written." }),
    ),
  );

const toEvent = Effect.fnUntraced(function* (row: Row) {
  const details = yield* decodeDetails(row.details_json);
  return yield* decodeEvent({
    sequence: row.sequence,
    id: row.id,
    at: row.at,
    kind: row.kind,
    projectId: row.project_id,
    threadId: row.thread_id,
    summary: row.summary,
    ...(row.feature_key === null ? {} : { featureKey: row.feature_key }),
    ...details,
  });
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const appended = yield* PubSub.unbounded<ActivityEvent>();
  // Serializes insert + publish so subscribers see events in sequence order.
  const writeLock = yield* Semaphore.make(1);

  const now = Clock.currentTimeMillis.pipe(
    Effect.map((ms) => DateTime.formatIso(DateTime.makeUnsafe(ms))),
  );
  const rowsToEvents = (rows: ReadonlyArray<Row>) => Effect.forEach(rows, toEvent);

  const append: ActivityLedger["Service"]["append"] = Effect.fn("ActivityLedger.append")(
    function* (input) {
      const { key, ...rest } = input;
      const draft = yield* decodeDraft(rest).pipe(
        Effect.mapError(
          (cause) =>
            new ActivityLedgerError({ message: `Invalid activity event: ${cause.message}` }),
        ),
      );
      return yield* writeLock.withPermit(
        storage(
          Effect.gen(function* () {
            const details = yield* encodeDetails({
              featureTitle: draft.featureTitle,
              links: draft.links,
              next: draft.next,
              tests: draft.tests,
            });
            const at = yield* now;
            const inserted = yield* sql<Row>`
            INSERT INTO activity_events
              (id, idempotency_key, at, kind, project_id, thread_id, feature_key, summary, details_json)
            VALUES (${NodeCrypto.randomUUID()}, ${key}, ${at}, ${draft.kind}, ${draft.projectId},
              ${draft.threadId}, ${draft.featureKey ?? null}, ${draft.summary}, ${details})
            ON CONFLICT (idempotency_key) DO NOTHING
            RETURNING *`;
            if (inserted[0] !== undefined) {
              const event = yield* toEvent(inserted[0]);
              yield* PubSub.publish(appended, event);
              return { event, created: true };
            }
            const existing =
              yield* sql<Row>`SELECT * FROM activity_events WHERE idempotency_key = ${key}`;
            return { event: yield* toEvent(existing[0]!), created: false };
          }),
        ),
      );
    },
  );

  const list: ActivityLedger["Service"]["list"] = Effect.fn("ActivityLedger.list")(function* (
    query,
  ) {
    const filters = [
      ...(query.since === undefined ? [] : [sql`at > ${query.since}`]),
      ...(query.afterSequence === undefined ? [] : [sql`sequence > ${query.afterSequence}`]),
      ...(query.projectId === undefined ? [] : [sql`project_id = ${query.projectId}`]),
      ...(query.featureKey === undefined ? [] : [sql`feature_key = ${query.featureKey}`]),
      ...(query.kinds === undefined || query.kinds.length === 0
        ? []
        : [sql`kind IN ${sql.in(query.kinds)}`]),
    ];
    // Newest `limit` events, returned oldest first.
    const rows = yield* sql<Row>`
        SELECT * FROM (
          SELECT * FROM activity_events
          ${filters.length === 0 ? sql`` : sql`WHERE ${sql.and(filters)}`}
          ORDER BY sequence DESC LIMIT ${query.limit}
        ) ORDER BY sequence ASC`;
    return yield* rowsToEvents(rows);
  }, storage);

  const stream: ActivityLedger["Service"]["stream"] = (filter) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before backfilling so nothing appended in between is lost.
        const subscription = yield* PubSub.subscribe(appended);
        const backfill =
          filter.afterSequence === undefined
            ? []
            : yield* list({
                afterSequence: filter.afterSequence,
                projectId: filter.projectId,
                limit: BACKFILL_LIMIT,
              });
        const after = backfill.at(-1)?.sequence ?? filter.afterSequence ?? -1;
        const live = Stream.fromSubscription(subscription).pipe(
          Stream.filter(
            (event) =>
              event.sequence > after &&
              (filter.projectId === undefined || event.projectId === filter.projectId),
          ),
        );
        return Stream.concat(Stream.fromIterable(backfill), live);
      }),
    );

  const getCheckIn: ActivityLedger["Service"]["getCheckIn"] = Effect.fn(
    "ActivityLedger.getCheckIn",
  )(function* (userKey) {
    const rows = yield* sql<{ readonly seen_at: string; readonly seen_sequence: number }>`
        SELECT seen_at, seen_sequence FROM activity_check_ins WHERE user_key = ${userKey}`;
    const row = rows[0];
    return row === undefined ? null : { seenAt: row.seen_at, seenSequence: row.seen_sequence };
  }, storage);

  const sinceCheckIn: ActivityLedger["Service"]["sinceCheckIn"] = Effect.fn(
    "ActivityLedger.sinceCheckIn",
  )(function* (userKey) {
    const checkIn = yield* getCheckIn(userKey);
    // One past the limit tells the client there is more than it was sent.
    const events = yield* list({
      afterSequence: checkIn?.seenSequence ?? 0,
      limit: SINCE_CHECK_IN_LIMIT + 1,
    });
    const truncated = events.length > SINCE_CHECK_IN_LIMIT;
    return { checkIn, events: truncated ? events.slice(1) : events, truncated };
  });

  const markSeen: ActivityLedger["Service"]["markSeen"] = Effect.fn("ActivityLedger.markSeen")(
    function* (userKey, seenSequence) {
      const [latest] = yield* sql<{ readonly sequence: number | null }>`
        SELECT MAX(sequence) AS sequence FROM activity_events`;
      const head = latest?.sequence ?? 0;
      const target = Math.min(seenSequence ?? head, head);
      const seenAt = yield* now;
      // Never move a check-in backwards, e.g. from a stale second device.
      const [row] = yield* sql<{ readonly seen_at: string; readonly seen_sequence: number }>`
        INSERT INTO activity_check_ins (user_key, seen_at, seen_sequence)
        VALUES (${userKey}, ${seenAt}, ${target})
        ON CONFLICT (user_key) DO UPDATE SET
          seen_at = excluded.seen_at,
          seen_sequence = MAX(activity_check_ins.seen_sequence, excluded.seen_sequence)
        RETURNING seen_at, seen_sequence`;
      return { seenAt: row!.seen_at, seenSequence: row!.seen_sequence };
    },
    storage,
  );

  return ActivityLedger.of({ append, list, stream, getCheckIn, sinceCheckIn, markSeen });
});

export const layer = Layer.effect(ActivityLedger, make);
