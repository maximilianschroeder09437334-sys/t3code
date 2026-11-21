import { EnvironmentQueryStore } from "@t3tools/client-runtime/state/query-persistence";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { MobileDatabase } from "../persistence/mobile-database";

export const cacheKindForQuery = (key: string) =>
  key.startsWith('["environment-data:hooks:list",') ? "hooks" : "pull-request";

export const layer = Layer.effect(
  EnvironmentQueryStore,
  Effect.gen(function* () {
    const database = yield* MobileDatabase;
    return {
      load: (environmentId, key) =>
        database
          .loadCache(environmentId, cacheKindForQuery(key), `v1:${key}`)
          .pipe(Effect.catch(() => Effect.succeedNone)),
      save: (environmentId, key, payload) =>
        database
          .saveCache(environmentId, cacheKindForQuery(key), `v1:${key}`, 1, payload)
          .pipe(Effect.catch(() => Effect.logWarning("Offline query database save failed"))),
    } satisfies NonNullable<typeof EnvironmentQueryStore.Service>;
  }),
);
