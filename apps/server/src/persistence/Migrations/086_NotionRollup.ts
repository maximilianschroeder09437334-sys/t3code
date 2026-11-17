import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE notion_rollups (project_id TEXT NOT NULL, day TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', page_id TEXT, through_sequence INTEGER NOT NULL, synced_sequence INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (project_id, day))`;
  yield* sql`CREATE TABLE notion_rollup_members (event_sequence INTEGER PRIMARY KEY, project_id TEXT NOT NULL, day TEXT NOT NULL)`;
  yield* sql`CREATE INDEX notion_rollup_members_day ON notion_rollup_members(project_id, day, event_sequence)`;
  yield* sql`INSERT INTO notion_sync_cursor (name, sequence) VALUES ('rollup_backfill', 0)`;
});
