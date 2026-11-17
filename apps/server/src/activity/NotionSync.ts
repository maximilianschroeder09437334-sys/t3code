import type { ActivityEvent, ActivityLedgerError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlError from "effect/sql/SqlError";
import * as ActivityLedger from "./ActivityLedger.ts";
import type { NotionRequestError } from "./NotionClient.ts";
import {
  dailyProperties,
  eventLine,
  isoWeek,
  notionPageId,
  periodProperties,
  roadmapStage,
  topicProperties,
  type LogTarget,
} from "./NotionMapping.ts";
import * as NotionOutbox from "./NotionOutbox.ts";

const idResponse = Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }));
const childrenResponse = Schema.decodeUnknownEffect(
  Schema.Struct({ results: Schema.Array(Schema.Struct({ id: Schema.String })) }),
);
const queryResponse = Schema.decodeUnknownEffect(
  Schema.Struct({
    results: Schema.Array(Schema.Struct({ id: Schema.String })),
    has_more: Schema.optionalKey(Schema.Boolean),
  }),
);
const decodeRoadmap = Schema.decodeUnknownOption(
  Schema.Struct({
    properties: Schema.Struct({
      Stage: Schema.Struct({ select: Schema.NullOr(Schema.Struct({ name: Schema.String })) }),
    }),
  }),
);
const decodeDay = Schema.decodeUnknownOption(
  Schema.Struct({
    properties: Schema.Struct({
      Name: Schema.Struct({ title: Schema.Array(Schema.Struct({ plain_text: Schema.String })) }),
      Type: Schema.Struct({ select: Schema.NullOr(Schema.Struct({ name: Schema.String })) }),
      Date: Schema.Struct({ date: Schema.NullOr(Schema.Struct({ start: Schema.String })) }),
      Summary: Schema.Struct({ rich_text: Schema.Array(Schema.Unknown) }),
      "Last step": Schema.optionalKey(Schema.Struct({ rich_text: Schema.Array(Schema.Unknown) })),
      "last step": Schema.optionalKey(Schema.Struct({ rich_text: Schema.Array(Schema.Unknown) })),
      "Next steps": Schema.Struct({ rich_text: Schema.Array(Schema.Unknown) }),
    }),
  }),
);
const decodeParent = Schema.decodeUnknownOption(
  Schema.Struct({
    properties: Schema.Struct({
      "Parent item": Schema.Struct({
        relation: Schema.Array(Schema.Struct({ id: Schema.String })),
      }),
    }),
  }),
);
export interface Target {
  readonly dataSourceId: string | null;
  readonly format: LogTarget;
  readonly sharePage: string;
}
export interface Client {
  readonly request: (
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
  ) => Effect.Effect<unknown, NotionRequestError>;
}

const reportMissingToken = Effect.fn("NotionSync.reportMissingToken")(function* (
  event: ActivityEvent,
) {
  if (event.kind === "needs_you") return;
  const ledger = yield* ActivityLedger.ActivityLedger;
  yield* ledger.append({
    key: `notion-token:${event.projectId}`,
    kind: "needs_you",
    projectId: event.projectId,
    threadId: event.threadId,
    summary: "Configure the Notion API token for the T3 Server.",
  });
});

const syncOne = Effect.fn("NotionSync.syncOne")(function* (input: {
  readonly row: NotionOutbox.OutboxRow;
  readonly event: ActivityEvent;
  readonly target: Target | null;
  readonly client: Client;
  readonly now: number;
}) {
  const outbox = yield* NotionOutbox.NotionOutbox;
  const ledger = yield* ActivityLedger.ActivityLedger;
  const { row, event, target, client, now } = input;
  const fail = Effect.fn("NotionSync.fail")(function* (
    status: number | null,
    retryAfterMs: number,
    sharePage = target?.sharePage ?? "the configured Notion log",
  ) {
    if ((status === 401 || status === 403 || status === 404) && event.kind !== "needs_you") {
      yield* ledger.append({
        key: `notion-access:${event.projectId}:${sharePage}`,
        kind: "needs_you",
        projectId: event.projectId,
        threadId: event.threadId,
        summary: `Share ${sharePage.replace(/\s+/g, " ").slice(0, 300)} with the T3 Server connection.`,
      });
    }
    yield* outbox.rejected(row.event_sequence, status, now, retryAfterMs);
  });
  if (target?.dataSourceId === null || target === null) {
    yield* fail(404, 0);
    return;
  }
  const source = target.dataSourceId;
  const key =
    event.featureKey === undefined
      ? `event:${event.id}`
      : `feature:${event.projectId}:${event.featureKey}`;
  let page = yield* outbox.getPage(source, key);
  if (page?.startsWith("pending:")) {
    yield* outbox.defer(row.event_sequence, now + 60000);
    return;
  }
  if (page === null) {
    const day = NotionOutbox.berlinDay(event.at);
    const week = isoWeek(day);
    const ensurePeriod = Effect.fn("NotionSync.ensurePeriod")(function* (
      periodKey: string,
      date: string,
      name: string,
      type: string,
      parentId?: string,
    ) {
      const stored = yield* outbox.getPage(source, periodKey);
      if (stored !== null) {
        if (stored.startsWith("pending:")) {
          yield* outbox.defer(row.event_sequence, now + 60000);
          return null;
        }
        return stored;
      }
      const found = yield* client
        .request("POST", `data_sources/${source}/query`, {
          page_size: 2,
          filter: {
            and: [
              { property: "Type", select: { equals: type } },
              { property: "Date", date: { equals: date } },
            ],
          },
        })
        .pipe(Effect.result);
      if (found._tag === "Failure") {
        yield* fail(found.failure.status, found.failure.retryAfterMs);
        return null;
      }
      const decoded = yield* queryResponse(found.success).pipe(Effect.result);
      if (decoded._tag === "Failure") {
        yield* fail(null, 0);
        return null;
      }
      if (decoded.success.results.length === 1 && decoded.success.has_more !== true) {
        const existingId = decoded.success.results[0]!.id;
        if (parentId !== undefined) {
          const details = yield* client.request("GET", `pages/${existingId}`).pipe(Effect.result);
          if (details._tag === "Failure") {
            yield* fail(details.failure.status, details.failure.retryAfterMs);
            return null;
          }
          const relation = decodeParent(details.success);
          if (
            Option.isNone(relation) ||
            !relation.value.properties["Parent item"].relation.some(
              (entry) => entry.id === parentId,
            )
          ) {
            if (yield* outbox.reserveAux(row.event_sequence, source, periodKey))
              yield* outbox.reviewAux(row.event_sequence);
            else yield* outbox.defer(row.event_sequence, now + 60000);
            return null;
          }
        }
        const selected = yield* outbox.rememberPage(source, periodKey, existingId);
        if (selected.startsWith("pending:")) {
          yield* outbox.defer(row.event_sequence, now + 60000);
          return null;
        }
        return selected;
      }
      if (!(yield* outbox.reserveAux(row.event_sequence, source, periodKey))) {
        yield* outbox.defer(row.event_sequence, now + 60000);
        return null;
      }
      if (decoded.success.results.length > 1 || decoded.success.has_more === true) {
        yield* outbox.reviewAux(row.event_sequence);
        return null;
      }
      const created = yield* client
        .request("POST", "pages", {
          parent: { type: "data_source_id", data_source_id: source },
          properties: periodProperties(date, name, type, parentId),
        })
        .pipe(Effect.result);
      if (created._tag === "Failure") {
        yield* fail(created.failure.status, created.failure.retryAfterMs);
        return null;
      }
      const result = yield* idResponse(created.success).pipe(Effect.result);
      if (result._tag === "Failure") {
        yield* fail(null, 0);
        return null;
      }
      if (
        !(yield* outbox.completeAux(row.event_sequence, source, periodKey, result.success.id, true))
      )
        return null;
      return result.success.id;
    });
    const weekKey = `week:${event.projectId}:${week.key}`;
    const weekId = yield* ensurePeriod(
      weekKey,
      week.monday,
      target.format === "t3" ? `${week.key} · T3 Code` : week.key,
      target.format === "t3" ? "Week summary" : "Week Summary",
    );
    if (weekId === null) return;
    const dayKey = `day:${event.projectId}:${day}`;
    const dayId = yield* ensurePeriod(
      dayKey,
      day,
      target.format === "t3" ? `${day} · T3 Code` : day,
      target.format === "t3" ? "Daily entry" : "Daily Entry",
      weekId,
    );
    if (dayId === null) return;
    const existingTopic = yield* client
      .request("POST", `data_sources/${source}/query`, {
        page_size: 2,
        filter: {
          and: [
            {
              property: "Type",
              select: { equals: target.format === "t3" ? "Topic entry" : "Topic Entry" },
            },
            {
              property: "Name",
              title: { equals: event.featureTitle ?? event.featureKey ?? event.summary },
            },
          ],
        },
      })
      .pipe(Effect.result);
    if (existingTopic._tag === "Failure") {
      yield* fail(existingTopic.failure.status, existingTopic.failure.retryAfterMs);
      return;
    }
    const topics = yield* queryResponse(existingTopic.success).pipe(Effect.result);
    if (topics._tag === "Failure") {
      yield* fail(null, 0);
      return;
    }
    if (!(yield* outbox.reserveAux(row.event_sequence, source, key))) {
      yield* outbox.defer(row.event_sequence, now + 60000);
      return;
    }
    if (topics.success.results.length > 0 || topics.success.has_more === true) {
      yield* outbox.reviewAux(row.event_sequence);
      return;
    }
    const result = yield* client
      .request("POST", "pages", {
        parent: { type: "data_source_id", data_source_id: source },
        properties: {
          ...topicProperties(event, target.format, day),
          "Parent item": { relation: [{ id: dayId }] },
        },
      })
      .pipe(Effect.result);
    if (result._tag === "Failure") {
      yield* fail(result.failure.status, result.failure.retryAfterMs);
      return;
    }
    const parsed = yield* idResponse(result.success).pipe(Effect.result);
    if (parsed._tag === "Failure") {
      yield* fail(null, 0);
      return;
    }
    page = parsed.success.id;
    if (!(yield* outbox.completeAux(row.event_sequence, source, key, page, false))) return;
  }
  yield* outbox.attachPage(row.event_sequence, page);
  const properties = topicProperties(event, target.format, NotionOutbox.berlinDay(event.at));
  const lastStep = target.format === "t3" ? "Last step" : "last step";
  const updates = { [lastStep]: properties[lastStep], "Next steps": properties["Next steps"] };
  const update = yield* client
    .request("PATCH", `pages/${page}`, { properties: updates })
    .pipe(Effect.result);
  if (update._tag === "Failure") {
    yield* fail(update.failure.status, update.failure.retryAfterMs);
    return;
  }
  const stage = roadmapStage(event.kind);
  const roadmapUrl = event.links?.notionUrl;
  const roadmapId = roadmapUrl === undefined ? null : notionPageId(roadmapUrl);
  if (stage !== null && roadmapId !== null && roadmapUrl !== undefined) {
    const roadmap = yield* client.request("GET", `pages/${roadmapId}`).pipe(Effect.result);
    if (roadmap._tag === "Failure") {
      yield* fail(roadmap.failure.status, roadmap.failure.retryAfterMs, roadmapUrl);
      return;
    }
    const decoded = decodeRoadmap(roadmap.success);
    const ranks: Readonly<Record<string, number>> = {
      Brainstorm: 0,
      Planned: 1,
      Next: 2,
      Current: 3,
      Done: 4,
      Archived: 5,
    };
    const current = Option.isSome(decoded)
      ? decoded.value.properties.Stage.select?.name
      : undefined;
    if (
      Option.isSome(decoded) &&
      (current === undefined || (ranks[current] !== undefined && ranks[current]! < ranks[stage]!))
    ) {
      const change = yield* client
        .request("PATCH", `pages/${roadmapId}`, {
          properties: { Stage: { select: { name: stage } } },
        })
        .pipe(Effect.result);
      if (change._tag === "Failure") {
        yield* fail(change.failure.status, change.failure.retryAfterMs, roadmapUrl);
        return;
      }
    }
  }
  if (!(yield* outbox.begin(row.event_sequence, "appending"))) return;
  const appended = yield* client
    .request("PATCH", `blocks/${page}/children`, {
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: [{ type: "text", text: { content: eventLine(event) } }] },
        },
      ],
    })
    .pipe(Effect.result);
  if (appended._tag === "Failure") {
    yield* fail(appended.failure.status, appended.failure.retryAfterMs);
    return;
  }
  const parsed = yield* childrenResponse(appended.success).pipe(Effect.result);
  const block = parsed._tag === "Success" ? parsed.success.results[0]?.id : undefined;
  if (block === undefined) {
    yield* fail(null, 0);
    return;
  }
  yield* outbox.completed(row.event_sequence, block);
});

const syncDaily = Effect.fn("NotionSync.syncDaily")(function* (input: {
  readonly row: NotionOutbox.RollupRow;
  readonly target: Target | null;
  readonly client: Client;
  readonly now: number;
}) {
  const outbox = yield* NotionOutbox.NotionOutbox;
  const ledger = yield* ActivityLedger.ActivityLedger;
  const { row, target, client, now } = input;
  if (target?.dataSourceId === null || target === null) {
    yield* outbox.rejectRollup(row.project_id, row.day, 404, now, 0);
    return;
  }
  let page = row.page_id;
  if (page === null) {
    const existing = yield* client
      .request("POST", `data_sources/${target.dataSourceId}/query`, {
        page_size: 2,
        filter: {
          and: [
            {
              property: "Type",
              select: { equals: target.format === "t3" ? "Daily entry" : "Daily Entry" },
            },
            { property: "Date", date: { equals: row.day } },
          ],
        },
      })
      .pipe(Effect.result);
    if (existing._tag === "Failure") {
      yield* outbox.rejectRollup(
        row.project_id,
        row.day,
        existing.failure.status,
        now,
        existing.failure.retryAfterMs,
      );
      return;
    }
    const matches = yield* queryResponse(existing.success).pipe(Effect.result);
    if (matches._tag === "Failure") {
      yield* outbox.rejectRollup(row.project_id, row.day, null, now, 0);
      return;
    }
    if (matches.success.results.length !== 1 || matches.success.has_more === true) {
      yield* outbox.fallbackRollup(row.project_id, row.day, null);
      return;
    }
    page = matches.success.results[0]!.id;
  }
  const ownedKey = `owned:day:${row.project_id}:${row.day}`;
  const owned = yield* outbox.getPage(target.dataSourceId, ownedKey);
  if (owned !== page) {
    yield* outbox.fallbackRollup(row.project_id, row.day, page);
    return;
  }
  const fetched = yield* client.request("GET", `pages/${page}`).pipe(Effect.result);
  if (fetched._tag === "Failure") {
    yield* outbox.rejectRollup(
      row.project_id,
      row.day,
      fetched.failure.status,
      now,
      fetched.failure.retryAfterMs,
    );
    return;
  }
  const decoded = decodeDay(fetched.success);
  const props = Option.isSome(decoded) ? decoded.value.properties : null;
  const name = target.format === "t3" ? `${row.day} · T3 Code` : row.day;
  const step = target.format === "t3" ? props?.["Last step"] : props?.["last step"];
  const pristine =
    props !== null &&
    props.Name.title.map((part) => part.plain_text).join("") === name &&
    props.Type.select?.name === (target.format === "t3" ? "Daily entry" : "Daily Entry") &&
    props.Date.date?.start === row.day &&
    props.Summary.rich_text.length === 0 &&
    step?.rich_text.length === 0 &&
    props["Next steps"].rich_text.length === 0;
  if (!pristine) {
    yield* outbox.fallbackRollup(row.project_id, row.day, page);
    return;
  }
  yield* outbox.attachRollupPage(row.project_id, row.day, page);
  const counts = yield* outbox.rollupCounts(row.project_id, row.day, row.through_sequence);
  const [latest] = yield* ledger.listAfter(row.through_sequence - 1, 1);
  if (latest?.sequence !== row.through_sequence)
    return yield* Effect.die("Rollup event is missing");
  if (!(yield* outbox.beginRollup(row.project_id, row.day))) return;
  const properties = dailyProperties(row.day, counts, latest, target.format);
  const response = yield* client
    .request("PATCH", `pages/${page}`, { properties })
    .pipe(Effect.result);
  if (response._tag === "Failure") {
    yield* outbox.rejectRollup(
      row.project_id,
      row.day,
      response.failure.status,
      now,
      response.failure.retryAfterMs,
    );
    return;
  }
  const parsed = yield* idResponse(response.success).pipe(Effect.result);
  if (parsed._tag === "Failure" || parsed.success.id !== page) {
    yield* outbox.rejectRollup(row.project_id, row.day, null, now, 0);
    return;
  }
  yield* outbox.completeRollup(row.project_id, row.day, parsed.success.id, row.through_sequence);
});

export class NotionSync extends Context.Service<
  NotionSync,
  {
    readonly syncOne: (
      input: Parameters<typeof syncOne>[0],
    ) => Effect.Effect<void, ActivityLedgerError | SqlError.SqlError>;
    readonly syncDaily: (
      input: Parameters<typeof syncDaily>[0],
    ) => Effect.Effect<void, ActivityLedgerError | SqlError.SqlError>;
    readonly reportMissingToken: (event: ActivityEvent) => Effect.Effect<void, ActivityLedgerError>;
  }
>()("t3/activity/NotionSync") {}

const make = Effect.gen(function* () {
  const ledger = yield* ActivityLedger.ActivityLedger;
  const outbox = yield* NotionOutbox.NotionOutbox;
  // The underlying operations already create their own spans.
  return NotionSync.of({
    syncOne: Effect.fnUntraced(function* (input: Parameters<typeof syncOne>[0]) {
      return yield* syncOne(input).pipe(
        Effect.provideService(ActivityLedger.ActivityLedger, ledger),
        Effect.provideService(NotionOutbox.NotionOutbox, outbox),
      );
    }),
    syncDaily: Effect.fnUntraced(function* (input: Parameters<typeof syncDaily>[0]) {
      return yield* syncDaily(input).pipe(
        Effect.provideService(ActivityLedger.ActivityLedger, ledger),
        Effect.provideService(NotionOutbox.NotionOutbox, outbox),
      );
    }),
    reportMissingToken: Effect.fnUntraced(function* (event: ActivityEvent) {
      return yield* reportMissingToken(event).pipe(
        Effect.asVoid,
        Effect.provideService(ActivityLedger.ActivityLedger, ledger),
      );
    }),
  });
});

export const layer = Layer.effect(NotionSync, make);
