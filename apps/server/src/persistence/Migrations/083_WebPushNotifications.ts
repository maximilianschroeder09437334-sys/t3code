import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE web_push_subscriptions (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, subscription_json TEXT NOT NULL, label TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, last_status INTEGER)`;
  yield* sql`CREATE INDEX web_push_session ON web_push_subscriptions(session_id, enabled)`;
  yield* sql`CREATE TABLE web_push_thread_state (thread_id TEXT PRIMARY KEY, identity TEXT, phase TEXT, updated_at INTEGER NOT NULL)`;
  yield* sql`CREATE TABLE web_push_deliveries (id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, event_key TEXT NOT NULL, thread_id TEXT, payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, next_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_status INTEGER)`;
  yield* sql`CREATE INDEX web_push_delivery_due ON web_push_deliveries(status, next_at)`;
});
