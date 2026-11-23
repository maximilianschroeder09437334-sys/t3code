// Takeover rollback preflight: `node scripts/takeover-rollback-preflight.ts <state.sqlite>`.
// Run it on a copy of the state database (with its -wal file) before rolling desktop .24 back to
// .23. Opens the file read-only, prints every blocker as JSON, and exits 0 when rollback is
// allowed, 2 when it is blocked and 1 on an error. It never writes to the database.
import * as NodeSqlite from "node:sqlite";

import { takeoverRollbackBlockers } from "../apps/server/src/orchestration-v2/takeoverRollbackPreflight.ts";

const dbPath = process.argv[2];
if (dbPath === undefined) {
  console.error("usage: node scripts/takeover-rollback-preflight.ts <state.sqlite>");
  process.exit(1);
}
try {
  const database = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const blockers = takeoverRollbackBlockers(database, new Date().toISOString());
    console.log(JSON.stringify({ allowed: blockers.length === 0, blockers }, null, 2));
    process.exitCode = blockers.length === 0 ? 0 : 2;
  } finally {
    database.close();
  }
} catch (error) {
  console.error("takeover rollback preflight failed:", error);
  process.exitCode = 1;
}
