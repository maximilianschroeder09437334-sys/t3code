import type { ThreadId } from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

export class ThreadCommandExecutor extends Context.Service<
  ThreadCommandExecutor,
  KeyedLock.KeyedLock<ThreadId> & {
    readonly withHandoffCheckout: <A, E, R>(
      paths: ReadonlyArray<string>,
      kind: "claim" | "terminal",
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<Option.Option<A>, E, R>;
    /**
     * One thread deletion plans and commits at a time: each decides what its deleted fork
     * sources keep for the forks still alive. Take it before any thread lock.
     */
    readonly withDeletionLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("t3/orchestration-v2/ThreadCommandExecutor") {}

export const make = Effect.gen(function* () {
  const deletion = yield* Semaphore.make(1);
  const checkoutUsers = new Map<string, number>();
  return ThreadCommandExecutor.of({
    withHandoffCheckout: Effect.fn("ThreadCommandExecutor.withHandoffCheckout")(function* <A, E, R>(
      paths: ReadonlyArray<string>,
      kind: "claim" | "terminal",
      effect: Effect.Effect<A, E, R>,
    ) {
      const keys = [...new Set(paths)];
      const claim = kind === "claim";
      // Never wait here while a provider or terminal may hold the workspace lease.
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          if (
            keys.some((key) => {
              const users = checkoutUsers.get(key);
              return users !== undefined && (claim || users === -1);
            })
          )
            return false;
          for (const key of keys)
            checkoutUsers.set(key, claim ? -1 : (checkoutUsers.get(key) ?? 0) + 1);
          return true;
        }),
        (acquired) => (acquired ? Effect.asSome(effect) : Effect.succeedNone),
        (acquired) =>
          Effect.sync(() => {
            if (!acquired) return;
            for (const key of keys) {
              const users = checkoutUsers.get(key) ?? 0;
              if (users > 1) checkoutUsers.set(key, users - 1);
              else checkoutUsers.delete(key);
            }
          }),
      );
    }),
    ...(yield* KeyedLock.make<ThreadId>()),
    withDeletionLock: Effect.fn("ThreadCommandExecutor.withDeletionLock")(function* <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) {
      return yield* deletion.withPermit(effect);
    }),
  });
});

export const layer = Layer.effect(ThreadCommandExecutor, make);
