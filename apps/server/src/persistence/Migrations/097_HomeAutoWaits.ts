import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE home_auto_waits (
    waiting_thread_id TEXT NOT NULL,
    waiting_project_id TEXT NOT NULL,
    report_run_id TEXT NOT NULL,
    target_thread_id TEXT NOT NULL,
    target_environment_id TEXT NOT NULL,
    target_title TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (waiting_thread_id, report_run_id)
  )`;
  yield* sql`CREATE INDEX home_auto_wait_target ON home_auto_waits (target_thread_id, status)`;
});
