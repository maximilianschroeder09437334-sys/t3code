import type { ActivityEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ActivityLedger from "./ActivityLedger.ts";
import type { NotionRequestError } from "./NotionClient.ts";
import { eventLine, topicProperties, type LogTarget } from "./NotionMapping.ts";
import * as NotionOutbox from "./NotionOutbox.ts";

const idResponse = Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }));
const childrenResponse = Schema.decodeUnknownEffect(
  Schema.Struct({ results: Schema.Array(Schema.Struct({ id: Schema.String })) }),
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

export const syncOne = Effect.fn("NotionSync.syncOne")(function* (input: {
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
  ) {
    yield* outbox.rejected(row.event_sequence, status, now, retryAfterMs);
    if ((status === 401 || status === 403 || status === 404) && event.kind !== "needs_you") {
      yield* ledger.append({
        key: `notion-access:${event.projectId}:${target?.sharePage ?? "missing"}`,
        kind: "needs_you",
        projectId: event.projectId,
        threadId: event.threadId,
        summary: `Share ${target?.sharePage ?? "the configured Notion log"} with the T3 Server connection.`,
      });
    }
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
  if (page === null) {
    if (!(yield* outbox.begin(row.event_sequence, "creating"))) return;
    const result = yield* client
      .request("POST", "pages", {
        parent: { type: "data_source_id", data_source_id: source },
        properties: topicProperties(event, target.format),
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
    yield* outbox.created(row.event_sequence, source, key, page);
  }
  yield* outbox.attachPage(row.event_sequence, page);
  const update = yield* client
    .request("PATCH", `pages/${page}`, { properties: topicProperties(event, target.format) })
    .pipe(Effect.result);
  if (update._tag === "Failure") {
    yield* fail(update.failure.status, update.failure.retryAfterMs);
    return;
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
