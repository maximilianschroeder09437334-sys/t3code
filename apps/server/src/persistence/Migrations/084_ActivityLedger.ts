import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Append-only: `sequence` is the rowid alias, so it only grows while rows are never deleted.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE activity_events (sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, idempotency_key TEXT NOT NULL UNIQUE, at TEXT NOT NULL, kind TEXT NOT NULL, project_id TEXT NOT NULL, thread_id TEXT NOT NULL, feature_key TEXT, summary TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}')`;
  yield* sql`CREATE INDEX activity_events_at ON activity_events(at)`;
  yield* sql`CREATE INDEX activity_events_thread ON activity_events(thread_id, sequence)`;
  yield* sql`CREATE INDEX activity_events_feature ON activity_events(feature_key, sequence)`;
  yield* sql`CREATE TABLE activity_check_ins (user_key TEXT PRIMARY KEY, seen_at TEXT NOT NULL, seen_sequence INTEGER NOT NULL)`;
});
