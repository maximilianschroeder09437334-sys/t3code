import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import catalog from "./migrationSchemaCatalog.json" with { type: "json" };

// Captured from unchanged official 1-96 and custom modules on NodeSqliteClient, SQLite 3.53.2.
// Deduplicated sqlite_master definitions retain constraints, index predicates and trigger bodies.
const histories: Readonly<Record<string, readonly number[]>> = catalog.histories;
const normalize = (sql: string | null) =>
  (sql?.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\]|[^\s'"`\[]+/g) ?? []).join(" ");

export const validateMigrationSchema = Effect.fn("validateMigrationSchema")(function* (
  history: string,
  customIds: readonly number[],
) {
  const sql = yield* SqlClient.SqlClient;
  const actual = yield* sql<{
    readonly type: string;
    readonly name: string;
    readonly tbl_name: string;
    readonly sql: string | null;
  }>`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE substr(name, 1, 7) != 'sqlite_'`;
  const noFts = !actual.some((row) => row.name === "orchestration_v2_message_search");
  const key = noFts && histories[`nofts${history}`] !== undefined ? `nofts${history}` : history;
  const ids = histories[history === "custom" ? "0" : key];
  if (ids === undefined)
    return yield* new Migrator.MigrationError({
      kind: "BadState",
      message: "Unknown schema history. Nothing was changed.",
    });
  const expected = [...ids, ...customIds.flatMap((id) => histories[`custom${id}`] ?? [])].map(
    (id) => catalog.objects[id]!,
  );
  const tables = new Set(expected.filter((row) => row.type === "table").map((row) => row.name));
  const mismatch = expected.find(
    (row) =>
      !actual.some(
        (a) =>
          a.type === row.type && a.name === row.name && normalize(a.sql) === normalize(row.sql),
      ),
  );
  const officialNames = new Set(
    Object.entries(histories)
      .filter(([key]) => !key.startsWith("custom"))
      .flatMap(([, ids]) => ids.map((id) => catalog.objects[id]!.name)),
  );
  const extra = actual.find(
    (row) =>
      (tables.has(row.tbl_name) || (history !== "custom" && officialNames.has(row.name))) &&
      !expected.some((e) => e.type === row.type && e.name === row.name),
  );
  if (mismatch || extra)
    return yield* new Migrator.MigrationError({
      kind: "BadState",
      message: `Unexpected recorded schema object ${(mismatch ?? extra)!.name}. Nothing was changed.`,
    });
});
