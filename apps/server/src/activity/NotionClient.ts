import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export class NotionRequestError extends Schema.TaggedError<NotionRequestError>()(
  "NotionRequestError",
  {
    status: Schema.NullOr(Schema.Number),
    retryAfterMs: Schema.Number,
  },
) {}

export const makeNotionClient = Effect.fn("NotionClient.make")(function* (
  token: string,
  fetcher: typeof fetch = fetch,
) {
  const lock = yield* Semaphore.make(1);
  const next = yield* Ref.make(0);
  const request = Effect.fn("NotionClient.request")(function* (
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
  ) {
    return yield* lock.withPermit(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const due = yield* Ref.get(next);
        if (due > now) yield* Effect.sleep(due - now);
        const started = yield* Clock.currentTimeMillis;
        yield* Ref.set(next, started + 334);
        const encoded =
          body === undefined
            ? undefined
            : yield* encodeJson(body).pipe(
                Effect.mapError(() => new NotionRequestError({ status: null, retryAfterMs: 0 })),
              );
        const response = yield* Effect.tryPromise({
          try: () =>
            fetcher(`https://api.notion.com/v1/${path}`, {
              method,
              headers: {
                Authorization: `Bearer ${token}`,
                "Notion-Version": "2025-09-03",
                "Content-Type": "application/json",
              },
              ...(encoded === undefined ? {} : { body: encoded }),
            }),
          catch: () => new NotionRequestError({ status: null, retryAfterMs: 0 }),
        });
        if (!response.ok) {
          const retry = Number(response.headers.get("retry-after"));
          const retryAfterMs = Number.isFinite(retry) ? Math.max(0, retry * 1000) : 0;
          if (response.status === 429 && retryAfterMs > 0) {
            const rejectedAt = yield* Clock.currentTimeMillis;
            yield* Ref.set(next, Math.max(started + 334, rejectedAt + retryAfterMs));
          }
          return yield* new NotionRequestError({
            status: response.status,
            retryAfterMs,
          });
        }
        return yield* Effect.tryPromise({
          try: () => response.json() as Promise<unknown>,
          catch: () => new NotionRequestError({ status: null, retryAfterMs: 0 }),
        });
      }),
    );
  });
  return { request };
});
