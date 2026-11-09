import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE hook_resource_leases (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    run_id TEXT NOT NULL, resource TEXT NOT NULL, generation INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, status TEXT NOT NULL, backend_ended INTEGER NOT NULL DEFAULT 0,
    notification TEXT NOT NULL DEFAULT 'none', UNIQUE(thread_id, resource)
  )`;
  yield* sql`CREATE INDEX hook_resource_due ON hook_resource_leases(status, expires_at)`;
  yield* sql`CREATE TABLE hook_incidents (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    event TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    summary TEXT NOT NULL, receipt_json TEXT NOT NULL DEFAULT '{}'
  )`;
  yield* sql`CREATE TABLE hook_work_obligations (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, thread_id TEXT NOT NULL, run_id TEXT NOT NULL,
    summary TEXT NOT NULL, status TEXT NOT NULL, due_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    first_failure_at INTEGER, last_delivery_id TEXT, last_repair_prompt TEXT
  )`;
  yield* sql`CREATE INDEX hook_work_due ON hook_work_obligations(status, due_at)`;
  yield* sql`CREATE INDEX hook_incident_thread ON hook_incidents(thread_id, updated_at)`;
});
