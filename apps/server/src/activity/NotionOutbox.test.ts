import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as NotionOutbox from "./NotionOutbox.ts";

const layer = NotionOutbox.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
it.layer(layer)("NotionOutbox", (it) => {
  it.effect("atomically captures ascending batches and resumes after a failed checkpoint", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const outbox = yield* NotionOutbox.NotionOutbox;
      yield* sql`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1051)
        INSERT INTO activity_events (id,idempotency_key,at,kind,project_id,thread_id,summary)
        SELECT 'id'||x,'key'||x,'2026-01-01','progress','project','thread','event' FROM n`;
      const first = yield* outbox.capture(500);
      assert.strictEqual(first.length, 500);
      yield* sql`CREATE TRIGGER reject_cursor BEFORE UPDATE ON notion_sync_cursor BEGIN SELECT RAISE(ABORT, 'crash'); END`;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(outbox.capture(500))));
      const [checkpoint] = yield* sql<{
        sequence: number;
      }>`SELECT sequence FROM notion_sync_cursor WHERE name = 'activity'`;
      assert.strictEqual(checkpoint?.sequence, first.at(-1)?.event_sequence);
      const [count] = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM notion_outbox`;
      assert.strictEqual(count?.count, 500);
      yield* sql`DROP TRIGGER reject_cursor`;
      const second = yield* outbox.capture(500);
      const last = yield* outbox.capture(500);
      assert.strictEqual(second.length, 500);
      assert.strictEqual(last.length, 51);
      assert.strictEqual((yield* outbox.capture(500)).length, 0);
      assert.deepStrictEqual(
        [...first, ...second, ...last].map((r) => r.event_sequence),
        Array.from({ length: 1051 }, (_, i) => i + 1),
      );
      yield* outbox.fail(1, 429, 100);
      assert.strictEqual(
        (yield* outbox.due(1099, 1051)).some((r) => r.event_sequence === 1),
        false,
      );
      assert.strictEqual(
        (yield* outbox.due(1100, 1051)).some((r) => r.event_sequence === 1),
        true,
      );
      yield* outbox.fail(1, 403, 1100);
      assert.strictEqual((yield* outbox.fallback(10))[0]?.event_sequence, 1);
      assert.isTrue(yield* outbox.ack(1, "notion-page"));
      assert.isFalse(yield* outbox.ack(1, "another-page"));
      const [done] = yield* sql<{
        status: string;
        page_id: string;
      }>`SELECT status, page_id FROM notion_outbox WHERE event_sequence = 1`;
      assert.deepStrictEqual(done, { status: "done", page_id: "notion-page" });
      assert.strictEqual(yield* outbox.rememberPage("target", "feature", "page-1"), "page-1");
      assert.strictEqual(yield* outbox.rememberPage("target", "feature", "page-2"), "page-1");
      assert.strictEqual(yield* outbox.getPage("target", "feature"), "page-1");
      assert.isTrue(yield* outbox.begin(2, "creating"));
      yield* outbox.recover();
      assert.strictEqual((yield* outbox.fallback(10))[0]?.event_sequence, 2);
      assert.isTrue(yield* outbox.begin(3, "creating"));
      yield* outbox.created(3, "target", "other", "page-3");
      assert.strictEqual(yield* outbox.getPage("target", "other"), "page-3");
      assert.isTrue(yield* outbox.begin(3, "appending"));
      assert.isTrue(yield* outbox.completed(3, "block-3"));
      assert.isFalse(yield* outbox.completed(3, "block-other"));
      assert.isTrue(yield* outbox.begin(4, "appending"));
      yield* outbox.recover();
      assert.deepStrictEqual(
        (yield* outbox.fallback(10)).map((row) => row.event_sequence),
        [2, 4],
      );
    }),
  );
  it("backs off and sends access failures or repeated errors to fallback", () => {
    assert.deepStrictEqual(NotionOutbox.retryDecision(0, 429, 100), {
      status: "pending",
      attempts: 1,
      nextAt: 1100,
    });
    for (const code of [401, 403, 404])
      assert.strictEqual(NotionOutbox.retryDecision(0, code, 100).status, "fallback");
    assert.strictEqual(NotionOutbox.retryDecision(4, 500, 100).status, "fallback");
  });
});
