import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { makeNotionClient } from "./NotionClient.ts";

it.effect("paces Notion requests and reports retry-after without exposing the token", () =>
  Effect.gen(function* () {
    const requests: Array<RequestInit | undefined> = [];
    const fetcher: typeof fetch = (_url, init) => {
      requests.push(init);
      return Promise.resolve(
        requests.length === 1
          ? new Response(JSON.stringify({ id: "page" }), { status: 200 })
          : new Response("", { status: 429, headers: { "retry-after": "2" } }),
      );
    };
    const client = yield* makeNotionClient("sensitive", fetcher);
    assert.deepStrictEqual(yield* client.request("POST", "pages", { x: 1 }), { id: "page" });
    const fiber = yield* client
      .request("POST", "pages")
      .pipe(Effect.asVoid, Effect.flip, Effect.forkChild);
    yield* TestClock.adjust(333);
    assert.strictEqual(requests.length, 1);
    yield* TestClock.adjust(1);
    const error = yield* Fiber.join(fiber);
    assert.strictEqual(error.status, 429);
    assert.strictEqual(error.retryAfterMs, 2000);
    assert.notInclude(JSON.stringify(error), "sensitive");
    const third = yield* client
      .request("GET", "pages/example")
      .pipe(Effect.asVoid, Effect.flip, Effect.forkChild);
    yield* TestClock.adjust(1999);
    assert.strictEqual(requests.length, 2);
    yield* TestClock.adjust(1);
    yield* Fiber.join(third);
    assert.strictEqual(requests.length, 3);
    const headers = requests[0]?.headers as Record<string, string>;
    assert.strictEqual(headers["Notion-Version"], "2025-09-03");
  }),
);
