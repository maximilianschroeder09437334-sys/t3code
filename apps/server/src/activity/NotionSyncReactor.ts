import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ActivityLedger from "./ActivityLedger.ts";
import { makeNotionClient, NotionRequestError } from "./NotionClient.ts";
import * as NotionOutbox from "./NotionOutbox.ts";
import { syncOne, type Client } from "./NotionSync.ts";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const outbox = yield* NotionOutbox.NotionOutbox;
    const ledger = yield* ActivityLedger.ActivityLedger;
    const settings = yield* ServerSettings.ServerSettingsService;
    const files = yield* FileSystem.FileSystem;
    const secrets = yield* ServerSecretStore;
    const resolver = yield* SecretResolver.SecretResolver;
    const tokenFile = yield* Config.String("T3_NOTION_TOKEN_FILE").pipe(Config.withDefault(""));
    const cache = yield* Ref.make<{ token: string; client: Client } | null>(null);
    const tokenFor = Effect.fn("NotionSync.token")(function* (
      reference: {
        readonly provider: Parameters<typeof resolver.read>[0][number]["provider"];
        readonly reference: string;
      } | null,
    ) {
      if (tokenFile)
        return (yield* files.readFileString(tokenFile).pipe(Effect.orElseSucceed(() => ""))).trim();
      if (reference !== null)
        return (
          (yield* resolver.read([reference]).pipe(Effect.orElseSucceed(() => [])))[0]?.trim() ?? ""
        );
      const value = yield* secrets
        .get("notion.apiToken")
        .pipe(Effect.orElseSucceed(() => Option.none()));
      return Option.isSome(value) ? new TextDecoder().decode(value.value).trim() : "";
    });
    const tick = Effect.fn("NotionSync.tick")(function* () {
      yield* outbox.recover();
      while ((yield* outbox.capture(500)).length === 500) {
        /* Drain every durable page before advancing to live work. */
      }
      const config = (yield* settings.getSettings).notionSync;
      if (config === null) return;
      const token = yield* tokenFor(config.token);
      let cached = yield* Ref.get(cache);
      if (cached?.token !== token) {
        const client: Client =
          token === ""
            ? {
                request: () =>
                  Effect.fail(new NotionRequestError({ status: 401, retryAfterMs: 0 })),
              }
            : yield* makeNotionClient(token);
        cached = { token, client };
        yield* Ref.set(cache, cached);
      }
      const now = yield* Clock.currentTimeMillis;
      const rows = yield* outbox.due(now, 100);
      for (const row of rows) {
        const [event] = yield* ledger.listAfter(row.event_sequence - 1, 1);
        if (event?.sequence !== row.event_sequence)
          return yield* Effect.die("Outbox event is missing");
        const target = config.projects[event.projectId] ?? null;
        yield* syncOne({ row, event, target, client: cached.client, now });
      }
    });
    yield* forkParked(
      Effect.forever(
        Effect.gen(function* () {
          yield* tick().pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logWarning("Notion sync failed", { cause }),
            ),
          );
          yield* Effect.sleep("5 seconds");
        }),
      ),
    );
  }),
);
