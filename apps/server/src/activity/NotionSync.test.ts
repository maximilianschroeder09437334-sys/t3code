import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ActivityLedger from "./ActivityLedger.ts";
import { NotionRequestError } from "./NotionClient.ts";
import * as NotionOutbox from "./NotionOutbox.ts";
import * as Sync from "./NotionSync.ts";
import type { Client } from "./NotionSync.ts";

const base = Layer.merge(ActivityLedger.layer, NotionOutbox.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
);
const layer = Sync.layer.pipe(Layer.provideMerge(base));
const target = { dataSourceId: "source", format: "t3" as const, sharePage: "Log" };
it.layer(layer)("NotionSync", (it) => {
  it.effect("routes an existing matching topic to review instead of creating a duplicate", () =>
    Effect.gen(function* () {
      const ledger = yield* ActivityLedger.ActivityLedger;
      const outbox = yield* NotionOutbox.NotionOutbox;
      const sync = yield* Sync.NotionSync;
      const { event } = yield* ledger.append({
        key: "existing-topic",
        kind: "progress",
        projectId: ProjectId.make("existing-project"),
        threadId: ThreadId.make("thread"),
        featureKey: "feature",
        summary: "progress",
      });
      yield* outbox.capture(500);
      const row = (yield* outbox.due(0, 100)).find(
        (entry) => entry.event_sequence === event.sequence,
      )!;
      let queries = 0;
      let writes = 0;
      const client: Client = {
        request: (method, path) => {
          if (method === "GET")
            return Effect.succeed({
              properties: { "Parent item": { relation: [{ id: "week" }] } },
            });
          if (path.endsWith("/query")) {
            queries++;
            return Effect.succeed({
              results: [{ id: queries === 1 ? "week" : queries === 2 ? "day" : "existing-topic" }],
              has_more: false,
            });
          }
          writes++;
          return Effect.succeed({});
        },
      };
      yield* sync.syncOne({ row, event, target, client, now: 0 });
      assert.strictEqual(writes, 0);
      assert.strictEqual(
        (yield* outbox.fallbackForProject(event.projectId, 10))[0]?.event_sequence,
        event.sequence,
      );
    }),
  );
  it.effect("records a missing token once without calling it a sharing problem", () =>
    Effect.gen(function* () {
      const ledger = yield* ActivityLedger.ActivityLedger;
      const sync = yield* Sync.NotionSync;
      const { event } = yield* ledger.append({
        key: "missing-token",
        kind: "progress",
        projectId: ProjectId.make("token-project"),
        threadId: ThreadId.make("thread"),
        summary: "work",
      });
      yield* sync.reportMissingToken(event);
      yield* sync.reportMissingToken(event);
      const needsYou = yield* ledger.list({
        projectId: event.projectId,
        kinds: ["needs_you"],
        limit: 10,
      });
      assert.strictEqual(needsYou.length, 1);
      assert.strictEqual(needsYou[0]!.summary, "Configure the Notion API token for the T3 Server.");
    }),
  );
  it.effect("creates week, day and topic with parent relations", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(
        DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-16T23:30:00.000Z")),
      );
      const ledger = yield* ActivityLedger.ActivityLedger;
      const sync = yield* Sync.NotionSync;
      const outbox = yield* NotionOutbox.NotionOutbox;
      const { event } = yield* ledger.append({
        key: "hierarchy",
        kind: "progress",
        projectId: ProjectId.make("hierarchy-project"),
        threadId: ThreadId.make("thread"),
        featureKey: "feature",
        summary: "progress",
      });
      yield* TestClock.setTime(0);
      yield* outbox.capture(500);
      const row = (yield* outbox.due(0, 10)).find(
        (entry) => entry.event_sequence === event.sequence,
      );
      const created: Array<{ properties: Record<string, unknown> }> = [];
      const ids = ["week-page", "day-page", "topic-page"];
      const client: Client = {
        request: (_method, path, body) => {
          if (path.endsWith("/query")) return Effect.succeed({ results: [], has_more: false });
          if (path === "pages") {
            created.push(body as { properties: Record<string, unknown> });
            return Effect.succeed({ id: ids[created.length - 1] });
          }
          return Effect.succeed(path.endsWith("/children") ? { results: [{ id: "block" }] } : {});
        },
      };
      yield* sync.syncOne({ row: row!, event, target, client, now: 0 });
      assert.strictEqual(created.length, 3);
      assert.deepStrictEqual(created[1]!.properties["Parent item"], {
        relation: [{ id: "week-page" }],
      });
      assert.deepStrictEqual(created[2]!.properties["Parent item"], {
        relation: [{ id: "day-page" }],
      });
      assert.deepStrictEqual(created[1]!.properties.Date, { date: { start: "2026-11-17" } });
      assert.deepStrictEqual(created[2]!.properties.Date, { date: { start: "2026-11-17" } });
    }),
  );
  it.effect("persists page and event ids across replay; ambiguous writes go to fallback", () =>
    Effect.gen(function* () {
      const ledger = yield* ActivityLedger.ActivityLedger;
      const sync = yield* Sync.NotionSync;
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
          if (method === "GET")
            return Effect.succeed({
              properties: { "Parent item": { relation: [{ id: "existing-week" }] } },
            });
          return Effect.succeed(
            path.endsWith("/query")
              ? calls.filter((call) => call.endsWith("/query")).length > 2
                ? { results: [], has_more: false }
                : {
                    results: [
                      {
                        id:
                          calls.filter((call) => call.endsWith("/query")).length === 1
                            ? "existing-week"
                            : "existing-day",
                      },
                    ],
                    has_more: false,
                  }
              : path === "pages"
                ? { id: "page-1" }
                : path.endsWith("/children")
                  ? { results: [{ id: `block-${calls.length}` }] }
                  : {},
          );
        },
      };
      const row1 = (yield* outbox.due(0, 10)).find(
        (entry) => entry.event_sequence === first.event.sequence,
      );
      yield* sync.syncOne({ row: row1!, event: first.event, target, client, now: 0 });
      const row2 = (yield* outbox.due(0, 10)).find(
        (entry) => entry.event_sequence === second.event.sequence,
      );
      yield* sync.syncOne({ row: row2!, event: second.event, target, client, now: 0 });
      assert.strictEqual(calls.filter((call) => call === "POST pages").length, 1);
      assert.strictEqual((yield* outbox.capture(500)).length, 0);
      const rows = yield* sql<{
        page_id: string;
        block_id: string;
        status: string;
      }>`SELECT page_id, block_id, status FROM notion_outbox WHERE event_sequence IN (${first.event.sequence}, ${second.event.sequence}) ORDER BY event_sequence`;
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
      const row3 = (yield* outbox.due(0, 10)).find(
        (entry) => entry.event_sequence === third.event.sequence,
      );
      let timedOutRequests = 0;
      const timeout: Client = {
        request: (_method, path) => {
          if (path.endsWith("/query")) return Effect.succeed({ results: [], has_more: false });
          timedOutRequests++;
          return Effect.fail(new NotionRequestError({ status: null, retryAfterMs: 0 }));
        },
      };
      yield* sync.syncOne({ row: row3!, event: third.event, target, client: timeout, now: 0 });
      assert.strictEqual(
        (yield* outbox.fallbackForProject("project", 10))[0]?.event_sequence,
        third.event.sequence,
      );
      assert.isFalse(
        (yield* outbox.due(999999, 10)).some((row) => row.event_sequence === third.event.sequence),
      );
      const sameFeature = yield* ledger.append({
        key: "three-again",
        kind: "progress",
        projectId: ProjectId.make("project"),
        threadId: ThreadId.make("thread"),
        featureKey: "new-feature",
        summary: "another event",
      });
      yield* outbox.capture(500);
      assert.isFalse(
        (yield* outbox.due(0, 10)).some((row) => row.event_sequence === sameFeature.event.sequence),
      );
      assert.strictEqual(timedOutRequests, 1);
      assert.isTrue(yield* outbox.ackAux("project", third.event.sequence, "resolved-topic"));
      assert.isTrue(
        (yield* outbox.due(0, 10)).some((row) => row.event_sequence === third.event.sequence),
      );
      const fourth = yield* ledger.append({
        key: "four",
        kind: "progress",
        projectId: ProjectId.make("project"),
        threadId: ThreadId.make("thread"),
        featureKey: "no-access",
        summary: "fourth",
      });
      yield* outbox.capture(500);
      const row4 = (yield* outbox.due(0, 10)).find(
        (row) => row.event_sequence === fourth.event.sequence,
      );
      const denied: Client = {
        request: () => Effect.fail(new NotionRequestError({ status: 403, retryAfterMs: 0 })),
      };
      yield* sync.syncOne({ row: row4!, event: fourth.event, target, client: denied, now: 0 });
      assert.strictEqual((yield* outbox.fallbackForProject("project", 10)).length, 1);
      const needsYou = yield* ledger.list({
        projectId: fourth.event.projectId,
        kinds: ["needs_you"],
        limit: 10,
      });
      assert.strictEqual(needsYou.length, 1);
      assert.include(needsYou[0]!.summary, "Share Log with the T3 Server connection");
      yield* outbox.capture(500);
      const daily = (yield* outbox.rollupsDue("1970-01-02", 0, 10)).find(
        (row) => row.project_id === "project",
      );
      assert.isDefined(daily);
      const dailyCalls: string[] = [];
      yield* outbox.rememberPage("source", "owned:day:project:1970-01-01", "daily-page");
      let edited = false;
      const dailyClient: Client = {
        request: (method, path) => {
          dailyCalls.push(`${method} ${path}`);
          if (path.includes("/query"))
            return Effect.succeed({ results: [{ id: "daily-page" }], has_more: false });
          if (method === "GET")
            return Effect.succeed({
              properties: {
                Name: { title: [{ plain_text: "1970-01-01 · T3 Code" }] },
                Type: { select: { name: "Daily entry" } },
                Date: { date: { start: "1970-01-01" } },
                Summary: { rich_text: edited ? [{}] : [] },
                "Last step": { rich_text: [] },
                "Next steps": { rich_text: [] },
              },
            });
          edited = true;
          return Effect.succeed({ id: "daily-page" });
        },
      };
      yield* sync.syncDaily({ row: daily!, target, client: dailyClient, now: 0 });
      assert.deepStrictEqual(dailyCalls, [
        "POST data_sources/source/query",
        "GET pages/daily-page",
        "PATCH pages/daily-page",
      ]);
      assert.isFalse(
        (yield* outbox.rollupsDue("1970-01-02", 0, 10)).some((row) => row.project_id === "project"),
      );
      yield* ledger.append({
        key: "late",
        kind: "progress",
        projectId: ProjectId.make("project"),
        threadId: ThreadId.make("thread"),
        summary: "late event",
      });
      yield* outbox.capture(500);
      const updated = (yield* outbox.rollupsDue("1970-01-02", 0, 10)).find(
        (row) => row.project_id === "project",
      );
      yield* sync.syncDaily({ row: updated!, target, client: dailyClient, now: 0 });
      assert.deepStrictEqual(dailyCalls, [
        "POST data_sources/source/query",
        "GET pages/daily-page",
        "PATCH pages/daily-page",
        "GET pages/daily-page",
      ]);
      assert.strictEqual((yield* outbox.rollupsFallback("project", 10))[0]?.page_id, "daily-page");
      yield* ledger.append({
        key: "manual-day",
        kind: "progress",
        projectId: ProjectId.make("other-project"),
        threadId: ThreadId.make("other-thread"),
        summary: "preserve manual day",
      });
      yield* outbox.capture(500);
      const manual = (yield* outbox.rollupsDue("1970-01-02", 0, 10)).find(
        (row) => row.project_id === "other-project",
      );
      const queried: string[] = [];
      const manualClient: Client = {
        request: (method, path) => {
          queried.push(`${method} ${path}`);
          return Effect.succeed({ results: [{ id: "existing-day" }], has_more: false });
        },
      };
      yield* sync.syncDaily({ row: manual!, target, client: manualClient, now: 0 });
      assert.deepStrictEqual(queried, ["POST data_sources/source/query"]);
      assert.strictEqual(
        (yield* outbox.rollupsFallback("other-project", 10))[0]?.page_id,
        "existing-day",
      );
      const roadmapId = "41bf6c71fa5e8176841ef5950850ac93";
      const roadmapEvent = yield* ledger.append({
        key: "roadmap",
        kind: "done",
        projectId: ProjectId.make("project"),
        threadId: ThreadId.make("thread"),
        featureKey: "roadmap",
        summary: "finished",
        links: { notionUrl: `https://app.notion.com/p/${roadmapId}` },
      });
      yield* outbox.capture(500);
      const pending = yield* outbox.due(0, 10);
      const roadmapRow = pending.find((row) => row.event_sequence === roadmapEvent.event.sequence)!;
      const stageChanges: unknown[] = [];
      const roadmapClient: Client = {
        request: (method, path, body) => {
          if (path.endsWith("/query")) return Effect.succeed({ results: [], has_more: false });
          if (method === "GET")
            return Effect.succeed({ properties: { Stage: { select: { name: "Current" } } } });
          if (path === `pages/${roadmapId}`) stageChanges.push(body);
          return Effect.succeed(
            path === "pages"
              ? { id: "topic" }
              : path.endsWith("/children")
                ? { results: [{ id: "block" }] }
                : {},
          );
        },
      };
      yield* sync.syncOne({
        row: roadmapRow,
        event: roadmapEvent.event,
        target,
        client: roadmapClient,
        now: 0,
      });
      assert.deepStrictEqual(stageChanges, [
        { properties: { Stage: { select: { name: "Done" } } } },
      ]);
    }),
  );
});
