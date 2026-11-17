import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE notion_outbox (event_sequence INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, page_id TEXT, block_id TEXT, last_error TEXT)`;
  yield* sql`CREATE TABLE notion_sync_cursor (name TEXT PRIMARY KEY NOT NULL, sequence INTEGER NOT NULL)`;
  yield* sql`INSERT INTO notion_sync_cursor (name, sequence) VALUES ('activity', 0)`;
  yield* sql`CREATE INDEX notion_outbox_due ON notion_outbox(status, next_at, event_sequence)`;
  yield* sql`CREATE TABLE notion_sync_pages (target TEXT NOT NULL, page_key TEXT NOT NULL, page_id TEXT NOT NULL, PRIMARY KEY (target, page_key))`;
});
