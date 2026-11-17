import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ActivityLedger from "./ActivityLedger.ts";
import { NotionRequestError } from "./NotionClient.ts";
import * as NotionOutbox from "./NotionOutbox.ts";
import { syncOne, type Client } from "./NotionSync.ts";

const layer = Layer.merge(ActivityLedger.layer, NotionOutbox.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
);
const target = { dataSourceId: "source", format: "t3" as const, sharePage: "Log" };
it.layer(layer)("NotionSync", (it) => {
  it.effect("persists page and event ids across replay; ambiguous writes go to fallback", () =>
    Effect.gen(function* () {
      const ledger = yield* ActivityLedger.ActivityLedger;
      const outbox = yield* NotionOutbox.NotionOutbox;
      const sql = yield* SqlClient.SqlClient;
      const first = yield* ledger.append({
        key: "one",
        kind: "progress",
        projectId: ProjectId.make("project"),
        threadId: ThreadId.make("thread"),
        featureKey: "feature",
        summary: "first",
      });
      const second = yield* ledger.append({
        key: "two",
        kind: "done",
        projectId: ProjectId.make("project"),
        threadId: ThreadId.make("thread"),
        featureKey: "feature",
        summary: "second",
      });
      yield* outbox.capture(500);
      const calls: string[] = [];
      const client: Client = {
        request: (method, path) => {
          calls.push(`${method} ${path}`);
          return Effect.succeed(
            path === "pages"
              ? { id: "page-1" }
              : path.endsWith("/children")
                ? { results: [{ id: `block-${calls.length}` }] }
                : {},
          );
        },
      };
      const [row1, row2] = yield* outbox.due(0, 10);
      yield* syncOne({ row: row1!, event: first.event, target, client, now: 0 });
      yield* syncOne({ row: row2!, event: second.event, target, client, now: 0 });
      assert.strictEqual(calls.filter((call) => call === "POST pages").length, 1);
      assert.strictEqual((yield* outbox.capture(500)).length, 0);
      const rows = yield* sql<{
        page_id: string;
        block_id: string;
        status: string;
      }>`SELECT page_id, block_id, status FROM notion_outbox ORDER BY event_sequence`;
      assert.deepStrictEqual(
        rows.map((row) => [row.page_id, row.status]),
        [
          ["page-1", "done"],
          ["page-1", "done"],
        ],
      );
      assert.isTrue(rows.every((row) => row.block_id.startsWith("block-")));
      const third = yield* ledger.append({
        key: "three",
        kind: "progress",
        projectId: ProjectId.make("project"),
        threadId: ThreadId.make("thread"),
        featureKey: "new-feature",
        summary: "third",
      });
      yield* outbox.capture(500);
      const [row3] = yield* outbox.due(0, 10);
      const timeout: Client = {
        request: () => Effect.fail(new NotionRequestError({ status: null, retryAfterMs: 0 })),
      };
      yield* syncOne({ row: row3!, event: third.event, target, client: timeout, now: 0 });
      assert.strictEqual((yield* outbox.fallback(10))[0]?.event_sequence, third.event.sequence);
      assert.strictEqual((yield* outbox.due(999999, 10)).length, 0);
      const fourth = yield* ledger.append({
        key: "four",
        kind: "progress",
        projectId: ProjectId.make("project"),
        threadId: ThreadId.make("thread"),
        featureKey: "no-access",
        summary: "fourth",
      });
      yield* outbox.capture(500);
      const [row4] = yield* outbox.due(0, 10);
      const denied: Client = {
        request: () => Effect.fail(new NotionRequestError({ status: 403, retryAfterMs: 0 })),
      };
      yield* syncOne({ row: row4!, event: fourth.event, target, client: denied, now: 0 });
      assert.strictEqual((yield* outbox.fallback(10)).length, 2);
      const needsYou = yield* ledger.list({ kinds: ["needs_you"], limit: 10 });
      assert.strictEqual(needsYou.length, 1);
      assert.include(needsYou[0]!.summary, "Share Log with the T3 Server connection");
    }),
  );
});
