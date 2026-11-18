import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import { SqlError, SqlSyntaxError } from "effect/sql/SqlError";

import { validateMigrationSchema } from "./migrationSchemaValidation.ts";
import schemaCatalog from "./migrationSchemaCatalog.json" with { type: "json" };
import { ensureCustomMigrationTables, legacyCustomPrefix } from "./customMigrationLedger.ts";
import {
  hasPendingMigrations,
  migrationManifest,
  runMigrations,
  skippedV2Migrations,
} from "./Migrations.ts";
import V2Preview from "./Migrations/055_OrchestrationV2.ts";
import ThreadNotes from "./Migrations/080_ThreadNotes.ts";
import ScheduledThreadMode from "./Migrations/081_ScheduledTaskThreadMode.ts";
import HookAutomation from "./Migrations/082_HookAutomation.ts";
import WebPushNotifications from "./Migrations/083_WebPushNotifications.ts";

// Fixtures only: in-memory or temp-file databases, no server, hooks, push or scheduler.

// Inject only SQLite's documented unsupported-option response; run migration 69's real catch.
const buildNoFts = Effect.gen(function* () {
  yield* runMigrations({ toMigrationInclusive: 68 });
  const sql = yield* SqlClient.SqlClient;
  let unsupported = 0;
  const noFts = new Proxy(sql, {
    apply(target, thisArg, args) {
      if (String(args[0]).includes("CREATE VIRTUAL TABLE orchestration_v2_message_search")) {
        unsupported++;
        return Effect.fail(new SqlError({ reason: new SqlSyntaxError({ cause: { errcode: 1 } }) }));
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
  yield* runMigrations({ toMigrationInclusive: 69 }).pipe(
    Effect.provideService(SqlClient.SqlClient, noFts),
  );
  assert.strictEqual(unsupported, 1);
});

const legacyModules = [
  ["80_ThreadNotes", ThreadNotes],
  ["81_ScheduledTaskThreadMode", ScheduledThreadMode],
  ["82_HookAutomation", HookAutomation],
  ["83_WebPushNotifications", WebPushNotifications],
] as const;
const legacyLedgerNames = [
  "ThreadNotes",
  "ScheduledTaskThreadMode",
  "HookAutomation",
  "WebPushNotifications",
];

const memory = NodeSqliteClient.layer({ filename: ":memory:" });

// The ledger the pre-merge Maxi build wrote: official 1-79 plus its own 80-83 on the same table.
const buildLegacy = (count: number) =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 79 });
    if (count === 0) return;
    yield* Migrator.make({})({
      loader: Migrator.fromRecord(Object.fromEntries(legacyModules.slice(0, count))),
    });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE effect_sql_migrations SET created_at = '2026-11-0' || (migration_id - 79) || ' 10:00:00' WHERE migration_id > 79`;
  });

const populate = (count: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES ('thread-1', 'project-1', 'Kept thread', 'codex', 'full-access', 'default', '2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z', '{"k":1}')`;
    yield* sql`INSERT INTO orchestration_v2_events (event_id, thread_id, event_type, occurred_at, payload_json) VALUES ('event-1', 'thread-1', 'thread.created', '2026-11-01T00:00:00.000Z', '{}'), ('event-2', 'thread-1', 'message.sent', '2026-11-01T00:01:00.000Z', '{"text":"hi"}')`;
    yield* sql`INSERT INTO orchestration_v2_effect_outbox (effect_id, command_id, thread_id, effect_type, payload_json, status, available_at, created_at, updated_at) VALUES ('effect-1', 'command-1', 'thread-1', 'provider.turn.start', '{"queued":true}', 'pending', '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z')`;
    for (const [taskId, threadId] of [
      ["task-with-thread", "thread-1"],
      ["task-without-thread", null],
    ] as const) {
      yield* sql`INSERT INTO scheduled_tasks (task_id, title, prompt, enabled, schedule_json, project_id, thread_id, workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode, created_by, creation_source, created_at, updated_at, last_run_status, run_count) VALUES (${taskId}, ${taskId}, 'prompt', 0, '{}', 'project-1', ${threadId}, '{}', '{}', 'full-access', 'default', 'user', 'ui', '2026-11-01', '2026-11-01', 'never', 3)`;
    }
    if (count >= 2) {
      // Values that replaying the shifted UPDATE (thread_id IS NOT NULL -> continue) would clobber.
      yield* sql`UPDATE scheduled_tasks SET thread_mode = 'new_thread' WHERE task_id = 'task-with-thread'`;
      yield* sql`UPDATE scheduled_tasks SET thread_mode = 'continue' WHERE task_id = 'task-without-thread'`;
    }
    if (count >= 1) {
      yield* sql`INSERT INTO thread_notes (thread_id, request_id, created_at, content, attachments_json) VALUES ('thread-1', 'request-1', '2026-11-09', 'Preserve this note', '[{"id":"a"}]'), ('thread-1', 'request-2', '2026-11-10', 'Second note', '[]')`;
    }
    if (count >= 3) {
      yield* sql`INSERT INTO hook_resource_leases (id, project_id, thread_id, run_id, resource, generation, expires_at, status) VALUES ('lease-1', 'project-1', 'thread-1', 'run-1', 'port:3000', 2, 99, 'active')`;
      yield* sql`INSERT INTO hook_incidents (id, project_id, thread_id, event, status, created_at, updated_at, summary) VALUES ('incident-1', 'project-1', 'thread-1', 'Stop', 'open', 1, 2, 'kept incident')`;
      yield* sql`INSERT INTO hook_work_obligations (id, project_id, thread_id, run_id, summary, status, due_at) VALUES ('obligation-1', 'project-1', 'thread-1', 'run-1', 'kept obligation', 'pending', 5)`;
    }
    if (count >= 4) {
      yield* sql`INSERT INTO web_push_subscriptions (id, session_id, subscription_json, label, created_at) VALUES ('subscription-1', 'session-1', '{"endpoint":"https://push.invalid/1"}', 'iPad', 7)`;
      yield* sql`INSERT INTO web_push_thread_state (thread_id, identity, phase, updated_at) VALUES ('thread-1', 'identity-1', 'running', 8)`;
      yield* sql`INSERT INTO web_push_deliveries (id, subscription_id, event_key, thread_id, payload_json, created_at, next_at, expires_at) VALUES ('delivery-1', 'subscription-1', 'key-1', 'thread-1', '{}', 9, 10, 11)`;
    }
  });

const preservedTables = [
  "orchestration_v2_projection_threads",
  "orchestration_v2_events",
  "orchestration_v2_effect_outbox",
  "thread_notes",
  "hook_resource_leases",
  "hook_incidents",
  "hook_work_obligations",
  "web_push_subscriptions",
  "web_push_thread_state",
  "web_push_deliveries",
  "activity_events",
  "activity_check_ins",
] as const;

const tableExists = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return (
      (yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${table}`).length > 0
    );
  });

// Rows of every populated table that exists, keyed by table.
const rowsOfPreserved = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows: Record<string, unknown> = {};
  for (const table of preservedTables) {
    if (yield* tableExists(table)) {
      rows[table] = yield* sql.unsafe(`SELECT * FROM "${table}" ORDER BY 1, 2`);
    }
  }
  rows.scheduled_tasks = yield* sql`
    SELECT task_id, title, prompt, thread_id, run_count FROM scheduled_tasks ORDER BY task_id
  `;
  return rows;
});

const expectPreserved = (before: Record<string, unknown>) =>
  Effect.gen(function* () {
    const after = yield* rowsOfPreserved;
    for (const [table, rows] of Object.entries(before)) {
      assert.deepStrictEqual(after[table], rows, table);
    }
  });

const threadModes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly task_id: string;
    readonly thread_mode: string;
  }>`SELECT task_id, thread_mode FROM scheduled_tasks ORDER BY task_id`;
});

const officialLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly migration_id: number;
    readonly name: string;
    readonly created_at: string;
  }>`SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id`;
});

const officialHistory = Effect.map(officialLedger, (rows) =>
  rows.map((row) => [row.migration_id, row.name] as const),
);

const customLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly migration_id: number;
    readonly name: string;
    readonly origin: string;
    readonly created_at: string;
  }>`SELECT migration_id, name, origin, created_at FROM t3_custom_migrations ORDER BY migration_id`;
});

const shape = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const objects = yield* sql<{
    readonly type: string;
    readonly name: string;
  }>`SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index', 'trigger') ORDER BY type, name`;
  const described: string[] = [];
  for (const { type, name } of objects) {
    if (type === "trigger") {
      described.push(`trigger ${name}`);
      continue;
    }
    const pragma = type === "table" ? "table_info" : "index_info";
    const columns = yield* sql.unsafe<Record<string, unknown>>(`PRAGMA ${pragma}("${name}")`);
    described.push(
      `${type} ${name}: ${columns
        .map((column) =>
          type === "table"
            ? `${column.name}|${column.type}|${column.notnull}|${column.dflt_value}|${column.pk}`
            : `${column.name}`,
        )
        .join(", ")}`,
    );
  }
  return described;
});

const freshShape = Effect.gen(function* () {
  yield* runMigrations();
  return yield* shape;
}).pipe(Effect.provide(memory));

// Everything a failed startup must leave untouched: schema text and every row except FTS shadows.
const dump = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const master =
    yield* sql`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`;
  const rows: Record<string, unknown> = {};
  const tables = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`;
  for (const { name } of tables) {
    rows[name] = yield* sql.unsafe(`SELECT * FROM "${name}" `);
  }
  return { master, rows };
});

const integrity = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  assert.deepStrictEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
  assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
});

const officialExecutedFrom = (id: number) =>
  migrationManifest.filter(([manifestId]) => manifestId >= id);

const expectThreadModes = (count: number) =>
  Effect.gen(function* () {
    assert.deepStrictEqual(
      (yield* threadModes).map((row) => [row.task_id, row.thread_mode]),
      count >= 2
        ? [
            ["task-with-thread", "new_thread"],
            ["task-without-thread", "continue"],
          ]
        : [
            ["task-with-thread", "continue"],
            ["task-without-thread", "new_thread"],
          ],
    );
  });

const expectCurrent = Effect.gen(function* () {
  assert.deepStrictEqual(yield* officialHistory, migrationManifest);
  assert.deepStrictEqual(yield* shape, yield* freshShape);
  yield* integrity;
  const before = yield* dump;
  assert.deepStrictEqual(yield* runMigrations(), []);
  assert.deepStrictEqual(yield* dump, before);
});

describe("custom-through-83 histories", () => {
  it.effect.each([1, 2, 3, 4])(
    "upgrades the recognized custom prefix of %s migrations and keeps every record",
    (count) =>
      Effect.gen(function* () {
        yield* buildLegacy(count);
        yield* populate(count);
        const legacyLedger = yield* officialLedger;
        const rows = yield* rowsOfPreserved;

        assert.deepStrictEqual(yield* runMigrations(), officialExecutedFrom(count >= 2 ? 81 : 80));

        yield* expectPreserved(rows);
        yield* expectThreadModes(count);
        const customRows = yield* customLedger;
        assert.deepStrictEqual(
          customRows.map((row) => [row.migration_id, row.name, row.origin]),
          [
            ...legacyLedgerNames.slice(0, count).map((name, index) => [80 + index, name, "legacy"]),
            ...[
              [80, "ThreadNotes"],
              [82, "HookAutomation"],
              [83, "WebPushNotifications"],
              [84, "ActivityLedger"],
            ]
              .filter(([id]) => (id as number) > 79 + count)
              .map(([id, name]) => [id, name, "executed"]),
          ],
        );
        const sql = yield* SqlClient.SqlClient;
        // Old evidence stays verbatim and immutable.
        assert.deepStrictEqual(
          yield* sql`SELECT migration_id, name, created_at FROM t3_custom_migration_legacy_ledger ORDER BY migration_id`,
          legacyLedger,
        );
        assert.isTrue(
          Exit.isFailure(yield* Effect.exit(sql`DELETE FROM t3_custom_migration_legacy_ledger`)),
        );
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(sql`UPDATE t3_custom_migration_legacy_ledger SET name = 'x'`),
          ),
        );
        if (count >= 2) {
          const official80 = (yield* officialLedger).find((row) => row.migration_id === 80);
          assert.deepStrictEqual(official80, {
            migration_id: 80,
            name: "ScheduledTaskThreadMode",
            created_at: "2026-11-02 10:00:00",
          });
        }
        yield* expectCurrent;
      }).pipe(Effect.provide(memory)),
  );

  const rejected = {
    "an unknown row after the custom ledger": (sql: SqlClient.SqlClient) =>
      sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (84, 'FutureMainMigration')`,
    "a gap inside the custom prefix": (sql: SqlClient.SqlClient) =>
      sql`DELETE FROM effect_sql_migrations WHERE migration_id = 81`,
    "a renamed custom row": (sql: SqlClient.SqlClient) =>
      sql`UPDATE effect_sql_migrations SET name = 'HookAutomationX' WHERE migration_id = 82`,
    "a hole in the official history": (sql: SqlClient.SqlClient) =>
      sql`DELETE FROM effect_sql_migrations WHERE migration_id = 40`,
    "a renamed official row": (sql: SqlClient.SqlClient) =>
      sql`UPDATE effect_sql_migrations SET name = 'SiteLocalMigration' WHERE migration_id = 30`,
    "a recorded migration whose tables are missing": (sql: SqlClient.SqlClient) =>
      sql`DROP TABLE hook_incidents`,
    "a recorded migration whose table has another shape": (sql: SqlClient.SqlClient) =>
      sql`ALTER TABLE thread_notes ADD COLUMN extra TEXT`,
    "an altered hook partial predicate": (sql: SqlClient.SqlClient) =>
      Effect.gen(function* () {
        yield* sql`DROP INDEX hook_resource_due`;
        yield* sql`CREATE INDEX hook_resource_due ON hook_resource_leases(status, expires_at) WHERE status='unused'`;
      }),
    "a missing official imports table": (sql: SqlClient.SqlClient) =>
      sql`DROP TABLE orchestration_v2_legacy_imports`,
    "an invalid current task mode": (sql: SqlClient.SqlClient) =>
      sql`UPDATE scheduled_tasks SET thread_mode='INVALID'`,
    "a recorded thread mode without its column": (sql: SqlClient.SqlClient) =>
      sql`ALTER TABLE scheduled_tasks DROP COLUMN thread_mode`,
  };

  it.effect.each(Object.keys(rejected) as Array<keyof typeof rejected>)(
    "rejects %s without writing anything",
    (name) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* buildLegacy(4);
        yield* populate(4);
        yield* rejected[name](sql);
        const before = yield* dump;

        assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));

        assert.deepStrictEqual(yield* dump, before);
      }).pipe(Effect.provide(memory)),
  );

  it.effect(
    "rejects a prefix of two migrations when an unrecorded hook migration left its tables",
    () =>
      Effect.gen(function* () {
        yield* buildLegacy(2);
        yield* populate(2);
        yield* HookAutomation;
        const before = yield* dump;

        assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));

        assert.deepStrictEqual(yield* dump, before);
      }).pipe(Effect.provide(memory)),
  );

  it.effect("rejects a prefix of one migration when the thread mode column already exists", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* buildLegacy(1);
      yield* populate(1);
      yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN thread_mode TEXT NOT NULL DEFAULT 'new_thread'`;
      const before = yield* dump;

      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));

      assert.deepStrictEqual(yield* dump, before);
    }).pipe(Effect.provide(memory)),
  );

  it.effect.each([90, 81])(
    "rolls back everything when official migration %s fails, then retries after reopening",
    (failingId) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dbPath = path.join(yield* fs.makeTempDirectoryScoped(), "state.sqlite");
          const open = NodeSqliteClient.layer({ filename: dbPath });
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* buildLegacy(2);
            yield* populate(2);
            // A constraint error on the ledger insert reads as "another migrator holds the lock"; an
            // integer overflow is a genuine failure.
            yield* sql.unsafe(
              `CREATE TRIGGER inject_failure BEFORE INSERT ON effect_sql_migrations WHEN NEW.migration_id = ${failingId} BEGIN SELECT abs(-9223372036854775808); END`,
            );
          }).pipe(Effect.provide(open));
          const before = yield* dump.pipe(Effect.provide(open));

          const exit = yield* Effect.exit(runMigrations().pipe(Effect.provide(open)));
          assert.isTrue(Exit.isFailure(exit));
          assert.deepStrictEqual(yield* dump.pipe(Effect.provide(open)), before);

          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`DROP TRIGGER inject_failure`;
            assert.deepStrictEqual(yield* runMigrations(), officialExecutedFrom(81));
            yield* expectThreadModes(2);
            assert.deepStrictEqual(yield* officialHistory, migrationManifest);
          }).pipe(Effect.provide(open));
          yield* expectCurrent.pipe(Effect.provide(open));
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("official histories", () => {
  it.effect("accepts every unchanged official prefix against the durable schema catalog", () =>
    Effect.gen(function* () {
      for (let id = 1; id <= 96; id++) yield* runMigrations({ toMigrationInclusive: id });
      yield* runMigrations();
      yield* expectCurrent;
    }).pipe(Effect.provide(memory)),
  );
  it.effect("creates every table on a fresh database and starts again without writes", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* runMigrations(), migrationManifest);
      for (const table of preservedTables) assert.isTrue(yield* tableExists(table), table);
      assert.deepStrictEqual(
        (yield* customLedger).map((row) => [row.migration_id, row.name, row.origin]),
        [
          [80, "ThreadNotes", "executed"],
          [82, "HookAutomation", "executed"],
          [83, "WebPushNotifications", "executed"],
          [84, "ActivityLedger", "executed"],
        ],
      );
      yield* expectCurrent;
    }).pipe(Effect.provide(memory)),
  );

  it.effect("adds the custom tables to an official history through 80 and keeps its tasks", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 80 });
      yield* populate(0);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE scheduled_tasks SET thread_mode = 'new_thread' WHERE task_id = 'task-with-thread'`;
      yield* sql`UPDATE scheduled_tasks SET thread_mode = 'continue' WHERE task_id = 'task-without-thread'`;
      const rows = yield* rowsOfPreserved;

      assert.deepStrictEqual(yield* runMigrations(), officialExecutedFrom(81));

      yield* expectPreserved(rows);
      yield* expectThreadModes(2);
      assert.deepStrictEqual(
        (yield* customLedger).map((row) => [row.migration_id, row.origin]),
        [
          [80, "executed"],
          [82, "executed"],
          [83, "executed"],
          [84, "executed"],
        ],
      );
      yield* expectCurrent;
    }).pipe(Effect.provide(memory)),
  );

  it.effect("adds the custom tables to an official history through 96", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      for (const table of [
        "thread_notes",
        "hook_resource_leases",
        "hook_incidents",
        "hook_work_obligations",
        "web_push_subscriptions",
        "web_push_thread_state",
        "web_push_deliveries",
        "activity_events",
        "activity_check_ins",
        "t3_custom_migrations",
        "t3_custom_migration_legacy_ledger",
      ]) {
        yield* sql.unsafe(`DROP TABLE IF EXISTS "${table}"`);
      }
      yield* populate(0);
      const rows = yield* rowsOfPreserved;

      assert.deepStrictEqual(yield* runMigrations(), []);

      yield* expectPreserved(rows);
      assert.isTrue(yield* tableExists("thread_notes"));
      assert.isTrue(yield* tableExists("web_push_deliveries"));
      yield* expectCurrent;
    }).pipe(Effect.provide(memory)),
  );
});

const failCustomLedgerInsert = (id: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* ensureCustomMigrationTables();
    yield* sql.unsafe(
      `CREATE TRIGGER inject_failure BEFORE INSERT ON t3_custom_migrations WHEN NEW.migration_id = ${id} BEGIN SELECT abs(-9223372036854775808); END`,
    );
  });

const withoutCustomTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of [
    "thread_notes",
    "hook_resource_leases",
    "hook_incidents",
    "hook_work_obligations",
    "web_push_subscriptions",
    "web_push_thread_state",
    "web_push_deliveries",
    "activity_events",
    "activity_check_ins",
    "t3_custom_migrations",
    "t3_custom_migration_legacy_ledger",
  ]) {
    yield* sql.unsafe(`DROP TABLE IF EXISTS "${table}"`);
  }
});

describe("custom ledger runner", () => {
  it.effect("keeps finished custom migrations when a later one fails, then finishes on retry", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* withoutCustomTables;
      yield* failCustomLedgerInsert(83);

      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));

      assert.deepStrictEqual(yield* officialHistory, migrationManifest);
      assert.deepStrictEqual(
        (yield* customLedger).map((row) => row.migration_id),
        [80, 82],
      );
      assert.isTrue(yield* tableExists("hook_incidents"));
      assert.isFalse(yield* tableExists("web_push_subscriptions"));
      assert.isTrue(yield* hasPendingMigrations());

      yield* sql`DROP TRIGGER inject_failure`;
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(
        (yield* customLedger).map((row) => row.migration_id),
        [80, 82, 83, 84],
      );
      assert.isFalse(yield* hasPendingMigrations());
      yield* expectCurrent;
    }).pipe(Effect.provide(memory)),
  );

  it.effect(
    "rolls the whole upgrade back when the custom runner fails after the official one",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* buildLegacy(2);
        yield* populate(2);
        yield* failCustomLedgerInsert(83);
        const before = yield* dump;
        const rows = yield* rowsOfPreserved;

        assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
        assert.deepStrictEqual(yield* dump, before);

        yield* sql`DROP TRIGGER inject_failure`;
        assert.deepStrictEqual(yield* runMigrations(), officialExecutedFrom(81));
        yield* expectPreserved(rows);
        yield* expectThreadModes(2);
        yield* expectCurrent;
      }).pipe(Effect.provide(memory)),
  );

  it.effect("rejects an unconverted history beside a populated custom ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* buildLegacy(1);
      yield* ensureCustomMigrationTables();
      yield* sql`INSERT INTO t3_custom_migrations (migration_id, name, origin) VALUES (80, 'ThreadNotes', 'executed')`;
      const before = yield* dump;

      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));

      assert.deepStrictEqual(yield* dump, before);
    }).pipe(Effect.provide(memory)),
  );

  it.effect("rejects custom tables whose execution ledger was lost", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`DELETE FROM t3_custom_migrations WHERE migration_id = 80`;
      yield* sql`INSERT INTO provider_session_runtime (thread_id, provider_name, adapter_key, status, last_seen_at) VALUES ('kept', 'codex', 'codex', 'idle', '2026-11-16')`;
      const before = yield* dump;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(yield* dump, before);
    }).pipe(Effect.provide(memory)),
  );

  it.effect("rejects custom tables with another shape before writing any ledger row", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* withoutCustomTables;
      yield* sql`CREATE TABLE web_push_deliveries (id TEXT PRIMARY KEY)`;
      const before = yield* dump;

      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));

      assert.deepStrictEqual(yield* dump, before);
      assert.isFalse(yield* tableExists("t3_custom_migrations"));
    }).pipe(Effect.provide(memory)),
  );

  it.effect("reports pending work for every history shape and none once current", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* hasPendingMigrations());
      yield* runMigrations();
      assert.isFalse(yield* hasPendingMigrations());
      yield* withoutCustomTables;
      assert.isTrue(yield* hasPendingMigrations());
    }).pipe(Effect.provide(memory)),
  );

  it("recognizes only a complete custom ledger as convertible", () => {
    const official = migrationManifest.filter(([id]) => id < 80);
    const ledger = (count: number) => [
      ...official.map(([id, name]) => ({ id, name })),
      ...[
        { id: 80, name: "ThreadNotes" },
        { id: 81, name: "ScheduledTaskThreadMode" },
        { id: 82, name: "HookAutomation" },
        { id: 83, name: "WebPushNotifications" },
      ].slice(0, count),
    ];
    assert.strictEqual(legacyCustomPrefix(ledger(0), migrationManifest), undefined);
    assert.strictEqual(legacyCustomPrefix(ledger(3), migrationManifest), 3);
    assert.deepStrictEqual(skippedV2Migrations(ledger(4)), []);
    assert.strictEqual(
      legacyCustomPrefix([...ledger(2), { id: 84, name: "Other" }], migrationManifest),
      "invalid",
    );
    assert.notDeepEqual(skippedV2Migrations([...ledger(2), { id: 84, name: "Other" }]), []);
    assert.strictEqual(
      legacyCustomPrefix(
        ledger(3).filter((row) => row.id !== 81),
        migrationManifest,
      ),
      "invalid",
    );
  });
});

describe("repair round 1 preflight and sealing", () => {
  it.effect.each([80, 53])("rejects malformed notes before official/preview %s writes", (prefix) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: prefix === 53 ? 52 : prefix });
      if (prefix === 53)
        yield* Migrator.make({})({
          loader: Migrator.fromRecord({ "53_OrchestrationV2": V2Preview }),
        });
      yield* sql`CREATE TABLE thread_notes(id TEXT)`;
      yield* sql`INSERT INTO provider_session_runtime (thread_id, provider_name, adapter_key, status, last_seen_at) VALUES ('kept', 'codex', 'codex', 'idle', '2026-11-16')`;
      const before = yield* dump;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(yield* dump, before);
    }).pipe(Effect.provide(memory)),
  );
  const corrupt = {
    "missing recorded notes": (sql: SqlClient.SqlClient) => sql`DROP TABLE thread_notes`,
    "wrong custom name": (sql: SqlClient.SqlClient) =>
      sql`UPDATE t3_custom_migrations SET name='Wrong' WHERE migration_id=80`,
    "unknown custom id": (sql: SqlClient.SqlClient) =>
      sql`INSERT INTO t3_custom_migrations(migration_id,name,origin) VALUES(999,'Unknown','executed')`,
    "unknown official id": (sql: SqlClient.SqlClient) =>
      sql`INSERT INTO effect_sql_migrations(migration_id,name) VALUES(999,'Unknown')`,
    "low official hole": (sql: SqlClient.SqlClient) =>
      sql`DELETE FROM effect_sql_migrations WHERE migration_id=3`,
    "low official name": (sql: SqlClient.SqlClient) =>
      sql`UPDATE effect_sql_migrations SET name='Wrong' WHERE migration_id=3`,
    "changed notes constraint": (sql: SqlClient.SqlClient) =>
      Effect.gen(function* () {
        yield* sql`DROP TABLE thread_notes`;
        yield* sql`CREATE TABLE thread_notes(thread_id TEXT NOT NULL,request_id TEXT NOT NULL,created_at TEXT NOT NULL,content TEXT NOT NULL,attachments_json TEXT NOT NULL DEFAULT '[]',PRIMARY KEY(request_id,thread_id))`;
      }),
    "sqliteX destructive notes trigger": (sql: SqlClient.SqlClient) =>
      sql`CREATE TRIGGER sqliteX_destructive_note AFTER INSERT ON thread_notes BEGIN DELETE FROM thread_notes; END`,
    "destructive notes trigger": (sql: SqlClient.SqlClient) =>
      sql`CREATE TRIGGER destructive_note AFTER INSERT ON thread_notes BEGIN DELETE FROM thread_notes; END`,
  };
  it.effect.each(Object.keys(corrupt) as Array<keyof typeof corrupt>)(
    "rejects %s on current startup unchanged",
    (name) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        yield* corrupt[name](sql);
        const before = yield* dump;
        assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
        assert.deepStrictEqual(yield* dump, before);
      }).pipe(Effect.provide(memory)),
  );
  it.effect("rejects unrecorded lookalike notes with a destructive trigger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 96 });
      yield* ThreadNotes;
      yield* sql`CREATE TRIGGER destructive_note AFTER INSERT ON thread_notes BEGIN DELETE FROM thread_notes; END`;
      yield* sql`INSERT INTO provider_session_runtime (thread_id, provider_name, adapter_key, status, last_seen_at) VALUES ('kept', 'codex', 'codex', 'idle', '2026-11-16')`;
      const before = yield* dump;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(yield* dump, before);
    }).pipe(Effect.provide(memory)),
  );
  it.effect.each(["row", "trigger"])("rejects missing archive %s on reopen", (kind) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const open = NodeSqliteClient.layer({
          filename: path.join(yield* fs.makeTempDirectoryScoped(), "archive.sqlite"),
        });
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* buildLegacy(4);
          yield* runMigrations();
          yield* sql`DROP TRIGGER t3_custom_migration_legacy_ledger_no_delete`;
          if (kind === "row") {
            yield* sql`DELETE FROM t3_custom_migration_legacy_ledger WHERE migration_id=82`;
            yield* sql`CREATE TRIGGER t3_custom_migration_legacy_ledger_no_delete BEFORE DELETE ON t3_custom_migration_legacy_ledger BEGIN SELECT RAISE(ABORT, 'The archived migration ledger is immutable.'); END`;
          }
        }).pipe(Effect.provide(open));
        const before = yield* dump.pipe(Effect.provide(open));
        assert.isTrue(
          Exit.isFailure(yield* Effect.exit(runMigrations().pipe(Effect.provide(open)))),
        );
        assert.deepStrictEqual(yield* dump.pipe(Effect.provide(open)), before);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("seals the original ledger against every SQLite DML form", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* buildLegacy(4);
      const original = yield* officialLedger;
      yield* runMigrations();
      const before = yield* dump;
      for (const statement of [
        "INSERT INTO t3_custom_migration_legacy_ledger(migration_id,name,created_at) VALUES(999,'fake','fake')",
        "REPLACE INTO t3_custom_migration_legacy_ledger(migration_id,name,created_at) VALUES(80,'fake','fake')",
        "INSERT OR REPLACE INTO t3_custom_migration_legacy_ledger(migration_id,name,created_at) VALUES(80,'fake','fake')",
        "INSERT INTO t3_custom_migration_legacy_ledger(migration_id,name,created_at) VALUES(80,'fake','fake') ON CONFLICT(migration_id) DO UPDATE SET name=excluded.name",
        "UPDATE t3_custom_migration_legacy_ledger SET created_at='fake'",
        "DELETE FROM t3_custom_migration_legacy_ledger",
      ]) {
        assert.isTrue(Exit.isFailure(yield* Effect.exit(sql.unsafe(statement))), statement);
        assert.deepStrictEqual(yield* dump, before);
      }
      assert.deepStrictEqual(
        yield* sql`SELECT migration_id,name,created_at FROM t3_custom_migration_legacy_ledger ORDER BY migration_id`,
        original,
      );
    }).pipe(Effect.provide(memory)),
  );
});

describe("repair round 2 reserved bookkeeping", () => {
  it.effect.each([
    ["effect_sql_migrations", "view"],
    ["effect_sql_migrations", "index"],
    ["effect_sql_migrations", "trigger"],
    ["t3_custom_migrations", "view"],
    ["t3_custom_migrations", "index"],
    ["t3_custom_migrations", "trigger"],
    ["t3_custom_migration_legacy_ledger", "view"],
    ["t3_custom_migration_legacy_ledger", "index"],
    ["t3_custom_migration_legacy_ledger", "trigger"],
    ["t3_custom_migration_legacy_ledger_no_insert", "table"],
    ["t3_custom_migration_legacy_ledger_no_update", "view"],
    ["t3_custom_migration_legacy_ledger_no_delete", "index"],
    ["t3_custom_migration_legacy_ledger_no_insert", "trigger"],
  ])("rejects reserved %s occupied by a %s before official writes", ([name, type]) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 80 });
      if (name === "effect_sql_migrations")
        yield* sql`ALTER TABLE effect_sql_migrations RENAME TO original_ledger`;
      if (type === "view")
        yield* sql.unsafe(
          `CREATE VIEW "${name}" AS SELECT 80 AS migration_id, 'ThreadNotes' AS name, 'executed' AS origin, '2026' AS created_at`,
        );
      if (type === "index") yield* sql.unsafe(`CREATE INDEX "${name}" ON scheduled_tasks(title)`);
      if (type === "trigger")
        yield* sql.unsafe(
          `CREATE TRIGGER "${name}" AFTER INSERT ON scheduled_tasks BEGIN SELECT 1; END`,
        );
      if (type === "table") yield* sql.unsafe(`CREATE TABLE "${name}" (id TEXT)`);
      yield* sql`INSERT INTO provider_session_runtime (thread_id, provider_name, adapter_key, status, last_seen_at) VALUES ('kept', 'codex', 'codex', 'idle', '2026-11-16')`;
      const before = yield* dump;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(yield* dump, before);
    }).pipe(Effect.provide(memory)),
  );
  it.effect.each(["t3_custom_migrations", "t3_custom_migration_legacy_ledger"])(
    "rejects reserved %s view before preview writes",
    (name) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 52 });
        yield* Migrator.make({})({
          loader: Migrator.fromRecord({ "53_OrchestrationV2": V2Preview }),
        });
        yield* sql.unsafe(
          `CREATE VIEW "${name}" AS SELECT 80 AS migration_id, 'ThreadNotes' AS name, 'legacy' AS origin, '2026' AS created_at`,
        );
        const before = yield* dump;
        assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
        assert.deepStrictEqual(yield* dump, before);
      }).pipe(Effect.provide(memory)),
  );
});

describe("repair round 2 supported no-FTS history", () => {
  it.effect("accepts no-FTS prefixes 69 through 96 and upgrades with custom migrations", () =>
    Effect.gen(function* () {
      yield* buildNoFts;
      for (let id = 69; id <= 96; id++) {
        yield* runMigrations({ toMigrationInclusive: id });
        assert.deepStrictEqual(yield* officialHistory, migrationManifest.slice(0, id));
        assert.isFalse(yield* tableExists("orchestration_v2_message_search"));
      }
      yield* populate(0);
      const rows = yield* rowsOfPreserved;
      yield* runMigrations();
      yield* expectPreserved(rows);
      assert.deepStrictEqual(
        (yield* customLedger).map((row) => row.migration_id),
        [80, 82, 83, 84],
      );
      const before = yield* dump;
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* dump, before);
      assert.isFalse(yield* tableExists("orchestration_v2_message_search"));
      yield* integrity;
    }).pipe(Effect.provide(memory)),
  );
  it.effect.each([69, 96])("reopens supported no-FTS official%s and stays idempotent", (prefix) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const open = NodeSqliteClient.layer({
          filename: path.join(yield* fs.makeTempDirectoryScoped(), "nofts.sqlite"),
        });
        yield* Effect.gen(function* () {
          yield* buildNoFts;
          yield* runMigrations({ toMigrationInclusive: prefix });
        }).pipe(Effect.provide(open));
        yield* runMigrations().pipe(Effect.provide(open));
        const before = yield* dump.pipe(Effect.provide(open));
        assert.deepStrictEqual(yield* runMigrations().pipe(Effect.provide(open)), []);
        assert.deepStrictEqual(yield* dump.pipe(Effect.provide(open)), before);
        yield* integrity.pipe(Effect.provide(open));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect.each([true, false])(
    "accepts only the exact legacy hook FTS update trigger (exact: %s)",
    (exact) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* buildLegacy(4);
        yield* populate(4);
        const variant = schemaCatalog.histories.legacyHooks80
          .map((id) => schemaCatalog.objects[id]!)
          .find((row) => row.name === "orchestration_v2_message_search_update")!;
        yield* sql`DROP TRIGGER orchestration_v2_message_search_update`;
        yield* sql.unsafe(
          exact ? variant.sql! : variant.sql!.replace("new.streaming = 0", "new.streaming = 1"),
        );
        const original = yield* officialLedger;
        const rows = yield* rowsOfPreserved;
        if (exact) {
          assert.deepStrictEqual(yield* runMigrations(), officialExecutedFrom(81));
          yield* expectPreserved(rows);
          assert.deepStrictEqual(
            yield* sql`SELECT migration_id,name,created_at FROM t3_custom_migration_legacy_ledger ORDER BY migration_id`,
            original,
          );
          assert.deepStrictEqual(yield* runMigrations(), []);
          yield* integrity;
        } else {
          const before = yield* dump;
          yield* Effect.flip(runMigrations());
          assert.deepStrictEqual(yield* dump, before);
        }
      }).pipe(Effect.provide(memory)),
  );
  it.effect.each([1, 2, 3, 4])(
    "converts no-FTS legacy custom prefix %s preserving data and archive",
    (count) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* buildNoFts;
        yield* buildLegacy(count);
        yield* populate(count);
        const original = yield* officialLedger;
        const rows = yield* rowsOfPreserved;
        assert.deepStrictEqual(yield* runMigrations(), officialExecutedFrom(count >= 2 ? 81 : 80));
        yield* expectPreserved(rows);
        yield* expectThreadModes(count);
        assert.deepStrictEqual(
          yield* sql`SELECT migration_id,name,created_at FROM t3_custom_migration_legacy_ledger ORDER BY migration_id`,
          original,
        );
        const before = yield* dump;
        assert.deepStrictEqual(yield* runMigrations(), []);
        assert.deepStrictEqual(yield* dump, before);
        yield* integrity;
      }).pipe(Effect.provide(memory)),
  );
  it.effect.each([
    "CREATE TABLE orchestration_v2_message_search_data(id INTEGER PRIMARY KEY, block BLOB)",
    "CREATE TRIGGER orchestration_v2_message_search_insert AFTER INSERT ON orchestration_v2_projection_messages BEGIN SELECT 1; END",
    "CREATE TABLE orchestration_v2_message_search(text TEXT)",
    "DROP TABLE orchestration_v2_legacy_imports",
  ])("rejects partial FTS or unrelated schema damage unchanged: %s", (statement) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* buildNoFts;
      yield* sql.unsafe(statement);
      yield* sql`INSERT INTO provider_session_runtime (thread_id, provider_name, adapter_key, status, last_seen_at) VALUES ('kept', 'codex', 'codex', 'idle', '2026-11-16')`;
      const before = yield* dump;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(yield* dump, before);
    }).pipe(Effect.provide(memory)),
  );
});

describe("recorded official schema damage", () => {
  it.effect.each([
    [80, false, "ALTER TABLE scheduled_tasks DROP COLUMN thread_mode"],
    [80, false, "DROP INDEX idx_provider_session_runtime_instance"],
    [96, false, "DROP TRIGGER orchestration_v2_message_search_insert"],
    [96, true, "DROP INDEX idx_provider_session_runtime_instance"],
    [68, false, "DROP INDEX idx_provider_session_runtime_instance"],
    [
      96,
      false,
      "DROP TRIGGER orchestration_v2_message_search_insert; CREATE TRIGGER orchestration_v2_message_search_insert AFTER INSERT ON orchestration_v2_projection_messages BEGIN SELECT 1; END",
    ],
    [
      91,
      false,
      "DROP INDEX orchestration_v2_projection_turn_items_queued_input_idx; CREATE INDEX orchestration_v2_projection_turn_items_queued_input_idx ON orchestration_v2_projection_turn_items(run_id) WHERE type = 'user_message'",
    ],
    [
      80,
      false,
      "CREATE TRIGGER destructive_extra AFTER INSERT ON provider_session_runtime BEGIN DELETE FROM provider_session_runtime; END",
    ],
    [
      96,
      false,
      "DROP TABLE orchestration_v2_message_search; CREATE VIRTUAL TABLE orchestration_v2_message_search USING fts5(wrong)",
    ],
    [26, false, "ALTER TABLE provider_session_runtime ADD COLUMN provider_instance_id INTEGER"],
    [
      50,
      false,
      "ALTER TABLE projection_thread_messages ADD COLUMN context_json TEXT NOT NULL DEFAULT '{}'",
    ],
    [86, false, "ALTER TABLE projection_projects ADD COLUMN has_custom_title TEXT"],
  ] as const)(
    "rejects damaged history %s (custom=%s): %s before writes",
    ([through, custom, damage]) =>
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: through });
        if (custom) yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;

        yield* sql`INSERT INTO provider_session_runtime (thread_id, provider_name, adapter_key, status, last_seen_at) VALUES ('kept', 'codex', 'codex', 'idle', '2026-11-16')`;
        for (const statement of damage.split(/; (?=CREATE)/).filter(Boolean)) {
          yield* sql.unsafe(statement);
        }
        const before = yield* dump;
        assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
        assert.deepStrictEqual(yield* dump, before);
      }).pipe(Effect.provide(memory)),
  );
});

it.effect.each([
  {
    name: "26-provider",
    through: 26,
    changes: ["ALTER TABLE provider_session_runtime ADD COLUMN provider_instance_id TEXT"],
  },
  {
    name: "27-projection",
    through: 27,
    changes: ["ALTER TABLE projection_thread_sessions ADD COLUMN provider_instance_id TEXT"],
  },
  {
    name: "26-projection",
    through: 26,
    changes: ["ALTER TABLE projection_thread_sessions ADD COLUMN provider_instance_id TEXT"],
  },
  {
    name: "26-both",
    through: 26,
    changes: [
      "ALTER TABLE provider_session_runtime ADD COLUMN provider_instance_id TEXT",
      "ALTER TABLE projection_thread_sessions ADD COLUMN provider_instance_id TEXT",
    ],
  },
  {
    name: "50-context",
    through: 50,
    changes: ["ALTER TABLE projection_thread_messages ADD COLUMN context_json TEXT"],
  },
  {
    name: "86-title",
    through: 86,
    changes: [
      "ALTER TABLE projection_projects ADD COLUMN has_custom_title INTEGER NOT NULL DEFAULT 0",
    ],
  },
  {
    name: "91-queued",
    through: 91,
    changes: [
      "DROP INDEX orchestration_v2_projection_turn_items_queued_input_idx",
      "CREATE INDEX orchestration_v2_projection_turn_items_queued_input_idx ON orchestration_v2_projection_turn_items(run_id) WHERE type = 'user_message' AND json_extract(payload_json, '$.inputIntent') = 'queued_turn'",
    ],
  },
  {
    name: "73-search",
    through: 73,
    changes: [
      "DROP TRIGGER orchestration_v2_message_search_insert",
      "DROP TRIGGER orchestration_v2_message_search_update",
      "\n          CREATE TRIGGER orchestration_v2_message_search_insert\n          AFTER INSERT ON orchestration_v2_projection_messages\n          BEGIN\n            INSERT INTO orchestration_v2_message_search (rowid, text)\n            VALUES (new.rowid, json_extract(new.payload_json, '$.text'));\n          END\n        ",
      "\n          CREATE TRIGGER orchestration_v2_message_search_update\n          AFTER UPDATE OF payload_json ON orchestration_v2_projection_messages\n          BEGIN\n            DELETE FROM orchestration_v2_message_search WHERE rowid = old.rowid;\n            INSERT INTO orchestration_v2_message_search (rowid, text)\n            VALUES (new.rowid, json_extract(new.payload_json, '$.text'));\n          END\n        ",
    ],
  },
])("completes supported pending repair $name and preserves rows", ({ through, changes }) =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: through });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO provider_session_runtime (thread_id, provider_name, adapter_key, status, last_seen_at) VALUES ('kept', 'codex', 'codex', 'idle', '2026-11-16')`;
    const before = yield* sql`SELECT * FROM provider_session_runtime`;
    for (const change of changes) yield* sql.unsafe(change);
    yield* runMigrations();
    yield* validateMigrationSchema("96", [], { allowPendingRepairs: false });
    const after = yield* sql`SELECT * FROM provider_session_runtime`;
    assert.deepInclude(after[0], before[0]);
    yield* expectCurrent;
  }).pipe(Effect.provide(memory)),
);

it.effect.each([
  {
    through: 26,
    preparation: "ALTER TABLE provider_session_runtime ADD COLUMN provider_instance_id TEXT",
    damage: "DROP INDEX idx_provider_session_runtime_status",
  },
  {
    through: 50,
    preparation: "ALTER TABLE projection_thread_messages ADD COLUMN context_json TEXT",
    damage: "DROP INDEX idx_provider_session_runtime_instance",
  },
  {
    through: 86,
    preparation:
      "ALTER TABLE projection_projects ADD COLUMN has_custom_title INTEGER NOT NULL DEFAULT 0",
    damage: "DROP INDEX idx_provider_session_runtime_instance",
  },
])(
  "rejects unrelated damage beside supported repair at $through before writes",
  ({ through, preparation, damage }) =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: through });
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(preparation);
      yield* sql.unsafe(damage);
      const before = yield* dump;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(yield* dump, before);
    }).pipe(Effect.provide(memory)),
);
