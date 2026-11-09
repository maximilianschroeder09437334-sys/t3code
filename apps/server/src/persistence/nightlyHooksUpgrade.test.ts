import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "./Migrations.ts";
import ThreadNotes from "./Migrations/080_ThreadNotes.ts";
import ScheduledThreadMode from "./Migrations/081_ScheduledTaskThreadMode.ts";

it.effect.each(["custom", "official"] as const)(
  "upgrades the %s migration-80 history without losing notes",
  (baseline) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 79 });
      yield* Migrator.make({})({
        loader: Migrator.fromRecord(
          baseline === "custom"
            ? { "80_ThreadNotes": ThreadNotes }
            : { "80_ScheduledTaskThreadMode": ScheduledThreadMode },
        ),
      });
      if (baseline === "custom")
        yield* sql`INSERT INTO thread_notes (thread_id, request_id, created_at, content) VALUES ('thread', 'request', '2026-11-09', 'Preserve this note')`;
      yield* runMigrations();
      expect(yield* runMigrations()).toEqual([]);
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_tasks)`;
      expect(columns.some((column) => column.name === "thread_mode")).toBe(true);
      const tables = yield* sql<{
        readonly name: string;
      }>`SELECT name FROM sqlite_master WHERE type = 'table'`;
      expect(tables.some((table) => table.name === "hook_resource_leases")).toBe(true);
      const notes = yield* sql<{ readonly content: string }>`SELECT content FROM thread_notes`;
      expect(notes).toEqual(baseline === "custom" ? [{ content: "Preserve this note" }] : []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
