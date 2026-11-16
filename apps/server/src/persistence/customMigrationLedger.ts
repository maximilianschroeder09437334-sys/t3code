import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { validateMigrationSchema } from "./migrationSchemaValidation.ts";

import ThreadNotes from "./Migrations/080_ThreadNotes.ts";
import HookAutomation from "./Migrations/082_HookAutomation.ts";
import WebPushNotifications from "./Migrations/083_WebPushNotifications.ts";

// Maxi's own migrations live in a separate ledger so they never occupy an official migration id.
// Ids 80-83 are the names of the files and of the rows the pre-merge build wrote into the official
// ledger. Custom 81 is recognized only to convert that history: official 80 is the same statement.
export const customMigrationFiles = [
  [80, "ThreadNotes"],
  [81, "ScheduledTaskThreadMode"],
  [82, "HookAutomation"],
  [83, "WebPushNotifications"],
] as const;

const runnableCustomMigrations = [
  [80, "ThreadNotes", ThreadNotes],
  [82, "HookAutomation", HookAutomation],
  [83, "WebPushNotifications", WebPushNotifications],
] as const;

type Probe =
  | { readonly kind: "table"; readonly table: string; readonly columns: readonly string[] }
  | { readonly kind: "column"; readonly table: string; readonly column: string }
  | {
      readonly kind: "index";
      readonly table: string;
      readonly index?: string;
      readonly columns: readonly string[];
    };

const col = (name: string, type: string, notNull = true, defaultValue = "", pk = 0) =>
  `${name}|${type}|${notNull ? 1 : 0}|${defaultValue}|${pk}`;

// What each custom migration creates, in the form PRAGMA table_info / index_info reports it.
const customEffects: Record<number, readonly Probe[]> = {
  80: [
    {
      kind: "table",
      table: "thread_notes",
      columns: [
        col("thread_id", "TEXT", true, "", 1),
        col("request_id", "TEXT", true, "", 2),
        col("created_at", "TEXT"),
        col("content", "TEXT"),
        col("attachments_json", "TEXT", true, "'[]'"),
      ],
    },
  ],
  81: [
    {
      kind: "column",
      table: "scheduled_tasks",
      column: col("thread_mode", "TEXT", true, "'new_thread'"),
    },
  ],
  82: [
    {
      kind: "table",
      table: "hook_resource_leases",
      columns: [
        col("id", "TEXT", false, "", 1),
        col("project_id", "TEXT"),
        col("thread_id", "TEXT"),
        col("run_id", "TEXT"),
        col("resource", "TEXT"),
        col("generation", "INTEGER"),
        col("expires_at", "INTEGER"),
        col("status", "TEXT"),
        col("backend_ended", "INTEGER", true, "0"),
        col("notification", "TEXT", true, "'none'"),
      ],
    },
    { kind: "index", table: "hook_resource_leases", columns: ["thread_id", "resource"] },
    {
      kind: "index",
      table: "hook_resource_leases",
      index: "hook_resource_due",
      columns: ["status", "expires_at"],
    },
    {
      kind: "table",
      table: "hook_incidents",
      columns: [
        col("id", "TEXT", false, "", 1),
        col("project_id", "TEXT"),
        col("thread_id", "TEXT"),
        col("event", "TEXT"),
        col("status", "TEXT"),
        col("created_at", "INTEGER"),
        col("updated_at", "INTEGER"),
        col("attempts", "INTEGER", true, "0"),
        col("summary", "TEXT"),
        col("receipt_json", "TEXT", true, "'{}'"),
      ],
    },
    {
      kind: "index",
      table: "hook_incidents",
      index: "hook_incident_thread",
      columns: ["thread_id", "updated_at"],
    },
    {
      kind: "table",
      table: "hook_work_obligations",
      columns: [
        col("id", "TEXT", false, "", 1),
        col("project_id", "TEXT"),
        col("thread_id", "TEXT"),
        col("run_id", "TEXT"),
        col("summary", "TEXT"),
        col("status", "TEXT"),
        col("due_at", "INTEGER"),
        col("attempts", "INTEGER", true, "0"),
        col("first_failure_at", "INTEGER", false),
        col("last_delivery_id", "TEXT", false),
        col("last_repair_prompt", "TEXT", false),
      ],
    },
    {
      kind: "index",
      table: "hook_work_obligations",
      index: "hook_work_due",
      columns: ["status", "due_at"],
    },
  ],
  83: [
    {
      kind: "table",
      table: "web_push_subscriptions",
      columns: [
        col("id", "TEXT", false, "", 1),
        col("session_id", "TEXT"),
        col("subscription_json", "TEXT"),
        col("label", "TEXT"),
        col("enabled", "INTEGER", true, "1"),
        col("created_at", "INTEGER"),
        col("last_status", "INTEGER", false),
      ],
    },
    {
      kind: "index",
      table: "web_push_subscriptions",
      index: "web_push_session",
      columns: ["session_id", "enabled"],
    },
    {
      kind: "table",
      table: "web_push_thread_state",
      columns: [
        col("thread_id", "TEXT", false, "", 1),
        col("identity", "TEXT", false),
        col("phase", "TEXT", false),
        col("updated_at", "INTEGER"),
      ],
    },
    {
      kind: "table",
      table: "web_push_deliveries",
      columns: [
        col("id", "TEXT", false, "", 1),
        col("subscription_id", "TEXT"),
        col("event_key", "TEXT"),
        col("thread_id", "TEXT", false),
        col("payload_json", "TEXT"),
        col("status", "TEXT", true, "'pending'"),
        col("attempts", "INTEGER", true, "0"),
        col("created_at", "INTEGER"),
        col("next_at", "INTEGER"),
        col("expires_at", "INTEGER"),
        col("last_status", "INTEGER", false),
      ],
    },
    {
      kind: "index",
      table: "web_push_deliveries",
      index: "web_push_delivery_due",
      columns: ["status", "next_at"],
    },
  ],
};

const bookkeepingDefinitions = {
  t3_custom_migrations: `CREATE TABLE t3_custom_migrations (
      migration_id INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      origin TEXT NOT NULL CHECK (origin IN ('executed', 'adopted', 'legacy')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  t3_custom_migration_legacy_ledger: `CREATE TABLE t3_custom_migration_legacy_ledger (
      migration_id INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      archived_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
} as const;

const ledgerColumns = [
  col("migration_id", "INTEGER", true, "", 1),
  col("name", "TEXT"),
  col("origin", "TEXT"),
  col("created_at", "TEXT", true, "CURRENT_TIMESTAMP"),
];
const evidenceColumns = [
  col("migration_id", "INTEGER", true, "", 1),
  col("name", "TEXT"),
  col("created_at", "TEXT"),
  col("archived_at", "TEXT", true, "CURRENT_TIMESTAMP"),
];

const badState = (message: string) => new Migrator.MigrationError({ kind: "BadState", message });

const tableColumns = Effect.fn("customMigrationLedger.tableColumns")(function* (table: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql.unsafe<{
    readonly name: string;
    readonly type: string;
    readonly notnull: number;
    readonly dflt_value: string | null;
    readonly pk: number;
  }>(`PRAGMA table_info("${table}")`);
  return rows.map((row) =>
    col(row.name, row.type, row.notnull === 1, row.dflt_value ?? "", row.pk),
  );
});

const tableIndexes = Effect.fn("customMigrationLedger.tableIndexes")(function* (table: string) {
  const sql = yield* SqlClient.SqlClient;
  const list = yield* sql.unsafe<{ readonly name: string; readonly origin: string }>(
    `PRAGMA index_list("${table}")`,
  );
  const indexes: Array<{ readonly name: string; readonly columns: string[] }> = [];
  for (const { name } of list) {
    const info = yield* sql.unsafe<{ readonly seqno: number; readonly name: string }>(
      `PRAGMA index_info("${name}")`,
    );
    indexes.push({
      name,
      columns: info.toSorted((a, b) => a.seqno - b.seqno).map((column) => column.name),
    });
  }
  return indexes;
});

type ProbeResult = "absent" | "match" | "mismatch";

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

const probe = Effect.fn("customMigrationLedger.probe")(function* (check: Probe) {
  const columns = yield* tableColumns(check.table);
  if (check.kind === "table") {
    if (columns.length === 0) return "absent" satisfies ProbeResult;
    return sameList(columns, check.columns) ? "match" : "mismatch";
  }
  if (check.kind === "column") {
    if (columns.length === 0) return "mismatch" satisfies ProbeResult;
    const name = check.column.split("|")[0];
    const found = columns.find((column) => column.split("|")[0] === name);
    if (found === undefined) return "absent";
    return found === check.column ? "match" : "mismatch";
  }
  if (columns.length === 0) return "absent" satisfies ProbeResult;
  const indexes = yield* tableIndexes(check.table);
  const found = indexes.find((index) =>
    check.index === undefined
      ? index.name.startsWith("sqlite_autoindex_") && sameList(index.columns, check.columns)
      : index.name === check.index,
  );
  if (found === undefined) return check.index === undefined ? "mismatch" : "absent";
  return sameList(found.columns, check.columns) ? "match" : "mismatch";
});

type EffectsState = "absent" | "present" | "inconsistent";

// An unrecorded migration is safe to run only when none of its objects exist.
const effectsState = Effect.fn("customMigrationLedger.effectsState")(function* (id: number) {
  const results: ProbeResult[] = [];
  for (const check of customEffects[id] ?? []) results.push(yield* probe(check));
  if (results.every((result) => result === "absent")) return "absent" satisfies EffectsState;
  if (results.every((result) => result === "match")) return "present" satisfies EffectsState;
  return "inconsistent" satisfies EffectsState;
});

const hasTable = Effect.fn("customMigrationLedger.hasTable")(function* (table: string) {
  const sql = yield* SqlClient.SqlClient;
  return (
    (yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${table}`).length > 0
  );
});

const archiveGuardDefinition = (action: string) =>
  `CREATE TRIGGER t3_custom_migration_legacy_ledger_no_${action} BEFORE ${action} ON t3_custom_migration_legacy_ledger BEGIN SELECT RAISE(ABORT, 'The archived migration ledger is immutable.'); END`;

export const validateMigrationBookkeeping = Effect.fn("customMigrationLedger.validateBookkeeping")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const reserved = [
      ...["effect_sql_migrations", ...Object.keys(bookkeepingDefinitions)].map((name) => ({
        name,
        type: "table",
        table: name,
        definition: undefined,
      })),
      ...["insert", "update", "delete"].map((action) => ({
        name: `t3_custom_migration_legacy_ledger_no_${action}`,
        type: "trigger",
        table: "t3_custom_migration_legacy_ledger",
        definition: archiveGuardDefinition(action),
      })),
    ];
    const objects = yield* sql<{
      readonly type: string;
      readonly name: string;
      readonly tbl_name: string;
      readonly sql: string | null;
    }>`SELECT type, name, tbl_name, sql FROM sqlite_master`;
    for (const expected of reserved) {
      const conflicts = objects.filter((row) => row.name.toLowerCase() === expected.name);
      if (
        conflicts.some(
          (row) =>
            row.type !== expected.type ||
            row.tbl_name !== expected.table ||
            (expected.definition !== undefined &&
              row.sql?.replace(/\s+/g, " ").trim().toLowerCase() !==
                expected.definition.toLowerCase()),
        )
      ) {
        return yield* badState(
          `Incompatible reserved bookkeeping object ${expected.name}. Nothing was changed.`,
        );
      }
    }
  },
);

const readCustomLedger = Effect.fn("customMigrationLedger.read")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const checks = [
    ["t3_custom_migrations", ledgerColumns],
    ["t3_custom_migration_legacy_ledger", evidenceColumns],
  ] as const;
  for (const [table, expected] of checks) {
    if ((yield* hasTable(table)) && !sameList(yield* tableColumns(table), expected)) {
      return yield* badState(`The custom migration table ${table} has an unexpected shape.`);
    }
  }
  for (const [table, definition] of Object.entries(bookkeepingDefinitions)) {
    const rows = yield* sql<{
      readonly sql: string;
    }>`SELECT sql FROM sqlite_master WHERE name=${table} AND type='table'`;
    if (
      rows.length &&
      rows[0]!.sql.replace(/\s+/g, " ").trim() !== definition.replace(/\s+/g, " ").trim()
    ) {
      return yield* badState(
        `Unexpected bookkeeping constraints in ${table}. Nothing was changed.`,
      );
    }
  }
  if (
    (yield* hasTable("t3_custom_migrations")) !==
    (yield* hasTable("t3_custom_migration_legacy_ledger"))
  ) {
    return yield* badState("Incomplete custom bookkeeping tables. Nothing was changed.");
  }
  const recorded = (yield* hasTable("t3_custom_migrations"))
    ? yield* sql<{
        readonly migration_id: number;
        readonly name: string;
        readonly origin: string;
        readonly created_at: string;
      }>`SELECT migration_id, name, origin, created_at FROM t3_custom_migrations ORDER BY migration_id`
    : [];
  const archived = (yield* hasTable("t3_custom_migration_legacy_ledger"))
    ? yield* sql<{
        readonly migration_id: number;
        readonly name: string;
        readonly created_at: string;
      }>`SELECT migration_id, name, created_at FROM t3_custom_migration_legacy_ledger ORDER BY migration_id`
    : [];
  return { recorded, archived, archivedRows: archived.length };
});

/** Creates empty bookkeeping; conversion populates and seals the archive in its transaction. */
export const ensureCustomMigrationTables = Effect.fn("customMigrationLedger.ensureTables")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const definition of Object.values(bookkeepingDefinitions)) {
      yield* sql.unsafe(definition.replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS"));
    }
    yield* sql`CREATE TRIGGER IF NOT EXISTS t3_custom_migration_legacy_ledger_no_update
      BEFORE UPDATE ON t3_custom_migration_legacy_ledger
      BEGIN SELECT RAISE(ABORT, 'The archived migration ledger is immutable.'); END`;
    yield* sql`CREATE TRIGGER IF NOT EXISTS t3_custom_migration_legacy_ledger_no_delete
      BEFORE DELETE ON t3_custom_migration_legacy_ledger
      BEGIN SELECT RAISE(ABORT, 'The archived migration ledger is immutable.'); END`;
  },
);

export const sealLegacyArchive = Effect.fn("customMigrationLedger.seal")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TRIGGER IF NOT EXISTS t3_custom_migration_legacy_ledger_no_insert
    BEFORE INSERT ON t3_custom_migration_legacy_ledger
    BEGIN SELECT RAISE(ABORT, 'The archived migration ledger is immutable.'); END`;
});

export const validateCustomMigrationState = Effect.fn("customMigrationLedger.validate")(function* (
  official: ReadonlyArray<readonly [number, string]>,
  legacyCount?: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const { recorded, archived } = yield* readCustomLedger();
  if (recorded.length > 0) {
    const current = yield* sql<{
      readonly migration_id: number;
      readonly name: string;
    }>`SELECT migration_id,name FROM effect_sql_migrations ORDER BY migration_id`;
    if (
      current.length !== official.length ||
      official.some(([id, name], i) => current[i]?.migration_id !== id || current[i]?.name !== name)
    )
      return yield* badState(
        "Custom execution ledger requires completed official history. Nothing was changed.",
      );
  }
  const legacy = recorded.filter((row) => row.origin === "legacy");
  const count = legacy.length;
  const expectedIds = [80, 82, 83];
  const executed = recorded.filter((row) => row.origin !== "legacy");
  if (
    recorded.some(
      (row) =>
        !customMigrationFiles.some(([id, name]) => row.migration_id === id && row.name === name) ||
        !["legacy", "executed"].includes(row.origin),
    ) ||
    legacy.some((row, i) => row.migration_id !== 80 + i) ||
    executed.some(
      (row, i) => row.migration_id !== expectedIds.filter((id) => id >= 80 + count)[i],
    ) ||
    (recorded.some((row) => row.migration_id === 81) && count < 2)
  ) {
    return yield* badState(
      "Unknown custom migration identity, origin or prefix. Nothing was changed.",
    );
  }
  if (legacyCount !== undefined && (recorded.length || archived.length))
    return yield* badState("Mixed converted and legacy histories. Nothing was changed.");
  if (count === 0 && archived.length !== 0)
    return yield* badState("Unexpected archive. Nothing was changed.");
  if (count > 0) {
    const expected = [
      ...official.filter(([id]) => id < 80),
      ...customMigrationFiles.slice(0, count),
    ];
    const current = yield* sql<{
      readonly migration_id: number;
      readonly name: string;
      readonly created_at: string;
    }>`SELECT migration_id, name, created_at FROM effect_sql_migrations`;
    if (
      archived.length !== expected.length ||
      expected.some(
        ([id, name], i) =>
          archived[i]?.migration_id !== id ||
          archived[i]?.name !== name ||
          archived[i]?.created_at !==
            (id < 80
              ? current.find((r) => r.migration_id === id)?.created_at
              : legacy.find((r) => r.migration_id === id)?.created_at),
      ) ||
      (count >= 2 &&
        current.find((r) => r.migration_id === 80)?.created_at !== archived[80]?.created_at)
    ) {
      return yield* badState(
        "Original archived ledger is incomplete or inconsistent. Nothing was changed.",
      );
    }
  }
  if (recorded.length > 0) {
    for (const action of ["insert", "update", "delete"]) {
      const name = `t3_custom_migration_legacy_ledger_no_${action}`;
      const rows = yield* sql<{
        readonly sql: string;
      }>`SELECT sql FROM sqlite_master WHERE type='trigger' AND name=${name}`;
      const expected = archiveGuardDefinition(action);
      if (rows[0]?.sql.replace(/\s+/g, " ").trim().toLowerCase() !== expected.toLowerCase())
        return yield* badState("Archive protection is missing or altered. Nothing was changed.");
    }
  }
  const present: number[] = [];
  for (const [id, name] of runnableCustomMigrations) {
    const state = yield* effectsState(id);
    const applied =
      legacyCount === undefined
        ? recorded.some((r) => r.migration_id === id)
        : id < 80 + legacyCount;
    if (state !== (applied ? "present" : "absent"))
      return yield* badState(
        `Custom ${id}_${name} schema lacks recognized execution provenance or is inconsistent. Nothing was changed.`,
      );
    if (applied) present.push(id);
  }
  // Validate all custom constraints/index predicates/triggers, independently of column probes.
  yield* validateMigrationSchema("custom", present);
  if ((yield* effectsState(81)) === "present") {
    const invalid =
      yield* sql`SELECT 1 FROM scheduled_tasks WHERE thread_mode IS NULL OR thread_mode NOT IN ('new_thread', 'continue') LIMIT 1`;
    if (invalid.length)
      return yield* badState("Invalid scheduled task thread mode. Nothing was changed.");
  }
});

/**
 * How many of the pre-merge custom migrations (80-83) a recorded official ledger holds, when the
 * whole ledger is exactly official 1-79 followed by that prefix. `invalid` means custom rows mixed
 * with anything else; undefined means no custom row, an ordinary history.
 */
export function legacyCustomPrefix(
  recorded: ReadonlyArray<{ readonly id: number; readonly name: string }>,
  official: ReadonlyArray<readonly [number, string]>,
): number | "invalid" | undefined {
  const count = recorded.filter((row) =>
    customMigrationFiles.some(([id, name]) => id === row.id && name === row.name),
  ).length;
  if (count === 0) return undefined;
  const expected = [...official.filter(([id]) => id < 80), ...customMigrationFiles.slice(0, count)];
  const matches =
    recorded.length === expected.length &&
    expected.every(([id, name]) => recorded.some((row) => row.id === id && row.name === name));
  return matches ? count : "invalid";
}

/** Validates ledger and schema without writing; undefined when the ledger is not a custom one. */
export const planLegacyCustomConversion = Effect.fn("customMigrationLedger.plan")(function* (
  official: ReadonlyArray<readonly [number, string]>,
) {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* hasTable("effect_sql_migrations"))) return undefined;
  const rows = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations`;
  const count = legacyCustomPrefix(
    rows.map((row) => ({ id: row.migration_id, name: row.name })),
    official,
  );
  if (count === undefined) return undefined;
  if (count === "invalid") {
    return yield* badState(
      "This database records Maxi custom migrations beside an official history that is not exactly the known one, so it cannot be converted safely. Nothing was changed. Start the build that wrote it, or report this migration history.",
    );
  }
  const ledger = yield* readCustomLedger();
  if (ledger.recorded.length > 0 || ledger.archivedRows > 0) {
    return yield* badState(
      "This database has both a Maxi custom migration ledger and an unconverted custom history in the official ledger. Nothing was changed.",
    );
  }
  for (const [id, name] of customMigrationFiles) {
    const state = yield* effectsState(id);
    const expected = id < 80 + count ? "present" : "absent";
    if (state !== expected) {
      return yield* badState(
        `The recorded custom migration history says ${id}_${name} is ${expected === "present" ? "applied" : "not applied"}, but the database schema is ${state}. Nothing was changed.`,
      );
    }
  }
  return count;
});

/** Moves the validated custom rows out of the official ledger; run inside the upgrade transaction. */
export const convertLegacyCustomLedger = Effect.fn("customMigrationLedger.convert")(function* (
  count: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureCustomMigrationTables();
  yield* sql`INSERT INTO t3_custom_migration_legacy_ledger (migration_id, name, created_at)
    SELECT migration_id, name, created_at FROM effect_sql_migrations`;
  yield* sealLegacyArchive();
  yield* sql`INSERT INTO t3_custom_migrations (migration_id, name, origin, created_at)
    SELECT migration_id, name, 'legacy', created_at FROM effect_sql_migrations WHERE migration_id >= 80`;
  const [thread_mode] = yield* sql<{
    readonly created_at: string;
  }>`SELECT created_at FROM effect_sql_migrations WHERE migration_id = 81`;
  yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 80`;
  // Official 80 is the statement custom 81 already ran, so record it without running it again.
  if (count >= 2 && thread_mode !== undefined) {
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name, created_at)
      VALUES (80, 'ScheduledTaskThreadMode', ${thread_mode.created_at})`;
  }
});

const pendingCustomMigrations = Effect.fn("customMigrationLedger.pending")(function* () {
  const { recorded } = yield* readCustomLedger();
  return runnableCustomMigrations.filter(
    ([id]) => !recorded.some((row) => row.migration_id === id),
  );
});

export const hasPendingCustomMigrations = Effect.fn("customMigrationLedger.hasPending")(
  function* () {
    return (yield* pendingCustomMigrations()).length > 0;
  },
);

/**
 * Runs missing custom migrations one transaction each after startup validates all history/schema.
 */
export const runCustomMigrations = Effect.fn("customMigrationLedger.run")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pending = yield* pendingCustomMigrations();
  if (pending.length === 0) return [];
  const states: Array<readonly [number, string, EffectsState]> = [];
  for (const [id, name] of pending) states.push([id, name, yield* effectsState(id)]);
  const inconsistent = states.filter(([, , state]) => state !== "absent");
  if (inconsistent.length > 0) {
    return yield* badState(
      `The database schema partly contains custom migrations ${inconsistent.map(([id, name]) => `${id}_${name}`).join(", ")}, so they cannot be run or recorded. Nothing was changed.`,
    );
  }
  yield* ensureCustomMigrationTables();
  yield* sealLegacyArchive();
  const executed: Array<readonly [number, string]> = [];
  for (const [id, name, migration] of pending) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* migration;
        yield* sql`INSERT INTO t3_custom_migrations (migration_id, name, origin)
          VALUES (${id}, ${name}, ${"executed"})`;
      }),
    );
    executed.push([id, name]);
  }
  return executed;
});
