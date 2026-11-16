import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { ensureCustomMigrationTables, legacyCustomPrefix } from "./customMigrationLedger.ts";
import {
  hasPendingMigrations,
  migrationManifest,
  runMigrations,
  skippedV2Migrations,
} from "./Migrations.ts";
import ThreadNotes from "./Migrations/080_ThreadNotes.ts";
import ScheduledThreadMode from "./Migrations/081_ScheduledTaskThreadMode.ts";
import HookAutomation from "./Migrations/082_HookAutomation.ts";
import WebPushNotifications from "./Migrations/083_WebPushNotifications.ts";

// Fixtures only: in-memory or temp-file databases, no server, hooks, push or scheduler.

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
  }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'orchestration_v2_message_search%' AND sql NOT LIKE 'CREATE VIRTUAL%' ORDER BY name`;
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
        [80, 82, 83],
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

  it.effect("adopts custom tables that match exactly but have no ledger row", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`INSERT INTO thread_notes (thread_id, request_id, created_at, content) VALUES ('thread-1', 'request-1', '2026-11-09', 'Kept')`;
      yield* sql`DELETE FROM t3_custom_migrations WHERE migration_id = 80`;

      assert.deepStrictEqual(yield* runMigrations(), []);

      assert.deepStrictEqual(
        (yield* customLedger).map((row) => [row.migration_id, row.origin]),
        [
          [80, "adopted"],
          [82, "executed"],
          [83, "executed"],
        ],
      );
      assert.deepStrictEqual(yield* sql`SELECT content FROM thread_notes`, [{ content: "Kept" }]);
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
