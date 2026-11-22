import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import * as KeyedLock from "./KeyedLock.ts";

describe("KeyedLock", () => {
  it.effect("runs one holder of a key at a time, waiters in the order they queued", () =>
    Effect.gen(function* () {
      const lock = yield* KeyedLock.make<string>();
      const events = yield* Ref.make<ReadonlyArray<string>>([]);
      const record = (event: string) => Ref.update(events, (current) => [...current, event]);
      const firstEntered = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();

      const first = yield* lock
        .withLock(
          "key",
          record("first:start").pipe(
            Effect.andThen(Deferred.succeed(firstEntered, undefined)),
            Effect.andThen(Deferred.await(releaseFirst)),
            Effect.andThen(record("first:end")),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstEntered);
      const second = yield* lock.withLock("key", record("second")).pipe(Effect.forkChild);
      const third = yield* lock.withLock("key", record("third")).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.deepStrictEqual(yield* Ref.get(events), ["first:start"]);

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.joinAll([first, second, third]);
      assert.deepStrictEqual(yield* Ref.get(events), [
        "first:start",
        "first:end",
        "second",
        "third",
      ]);
    }),
  );

  it.effect("runs holders of different keys concurrently", () =>
    Effect.gen(function* () {
      const lock = yield* KeyedLock.make<string>();
      const entered = yield* Queue.unbounded<string>();
      const release = yield* Deferred.make<void>();
      const hold = (key: string) =>
        lock.withLock(key, Queue.offer(entered, key).pipe(Effect.andThen(Deferred.await(release))));

      const holders = yield* Effect.forEach(["a", "b"], hold, { concurrency: "unbounded" }).pipe(
        Effect.forkChild,
      );
      const both = new Set([yield* Queue.take(entered), yield* Queue.take(entered)]);
      assert.deepStrictEqual(both, new Set(["a", "b"]));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holders);
    }),
  );

  it.effect("keeps no lock for a key once its holders and waiters are gone", () =>
    Effect.gen(function* () {
      const lock = yield* KeyedLock.make<string>();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();

      const holder = yield* lock
        .withLock(
          "key",
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const abandoned = yield* lock.withLock("key", Effect.void).pipe(Effect.forkChild);
      const waiting = yield* lock.withLock("key", Effect.void).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.deepStrictEqual(yield* lock.activeKeys, ["key"]);

      yield* Fiber.interrupt(abandoned);
      assert.deepStrictEqual(yield* lock.activeKeys, ["key"]);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.joinAll([holder, waiting]);
      assert.strictEqual(
        yield* lock.withLock("other", Effect.fail("boom")).pipe(Effect.flip),
        "boom",
      );

      assert.deepStrictEqual(yield* lock.activeKeys, []);
    }),
  );

  it.effect("tryWithLock runs a free key and skips a held or awaited key without waiting", () =>
    Effect.gen(function* () {
      const lock = yield* KeyedLock.make<string>();
      assert.deepStrictEqual(yield* lock.tryWithLock("free", Effect.succeed(1)), Option.some(1));
      assert.deepStrictEqual(yield* lock.activeKeys, []);

      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* lock
        .withLock(
          "held",
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const ran = yield* Ref.make(false);
      assert.deepStrictEqual(yield* lock.tryWithLock("held", Ref.set(ran, true)), Option.none());

      // A queued waiter keeps the key reserved after the holder leaves, so try still misses.
      const waiterRelease = yield* Deferred.make<void>();
      const waiter = yield* lock
        .withLock("held", Deferred.await(waiterRelease))
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      assert.deepStrictEqual(yield* lock.tryWithLock("held", Ref.set(ran, true)), Option.none());
      yield* Deferred.succeed(waiterRelease, undefined);
      yield* Fiber.join(waiter);

      assert.isFalse(yield* Ref.get(ran));
      assert.deepStrictEqual(yield* lock.tryWithLock("held", Effect.succeed(2)), Option.some(2));
      assert.deepStrictEqual(yield* lock.activeKeys, []);
    }),
  );

  it.effect("tryWithLock holds the key against withLock and releases on failure and interruption", () =>
    Effect.gen(function* () {
      const lock = yield* KeyedLock.make<string>();
      const events = yield* Ref.make<ReadonlyArray<string>>([]);
      const record = (event: string) => Ref.update(events, (current) => [...current, event]);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();

      const tried = yield* lock
        .tryWithLock(
          "key",
          record("try:start").pipe(
            Effect.andThen(Deferred.succeed(entered, undefined)),
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(record("try:end")),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const blocked = yield* lock.withLock("key", record("blocking")).pipe(Effect.forkChild);
      assert.deepStrictEqual(yield* lock.tryWithLock("key", record("second-try")), Option.none());
      yield* Effect.yieldNow;
      assert.deepStrictEqual(yield* Ref.get(events), ["try:start"]);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.joinAll([tried, blocked]);
      assert.deepStrictEqual(yield* Ref.get(events), ["try:start", "try:end", "blocking"]);

      assert.strictEqual(
        yield* lock.tryWithLock("key", Effect.fail("boom")).pipe(Effect.flip),
        "boom",
      );
      assert.deepStrictEqual(yield* lock.activeKeys, []);

      const interruptedEntered = yield* Deferred.make<void>();
      const interrupted = yield* lock
        .tryWithLock(
          "key",
          Deferred.succeed(interruptedEntered, undefined).pipe(Effect.andThen(Effect.never)),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(interruptedEntered);
      yield* Fiber.interrupt(interrupted);
      assert.deepStrictEqual(yield* lock.activeKeys, []);
      assert.deepStrictEqual(yield* lock.tryWithLock("key", Effect.succeed(3)), Option.some(3));
    }),
  );

  it.effect("runner keeps each key's effects in run order and never holds up another key", () =>
    Effect.gen(function* () {
      const runner = yield* KeyedLock.makeRunner<string>();
      const events = yield* Ref.make<ReadonlyArray<string>>([]);
      const record = (event: string) => Ref.update(events, (current) => [...current, event]);
      const release = yield* Deferred.make<void>();
      const otherRan = yield* Deferred.make<void>();
      const busyRan = yield* Deferred.make<void>();

      yield* runner.run("busy", Effect.andThen(Deferred.await(release), record("busy:1")));
      yield* runner.run("busy", record("busy:2"));
      yield* runner.run(
        "busy",
        Effect.andThen(record("busy:3"), Deferred.succeed(busyRan, undefined)).pipe(Effect.asVoid),
      );
      yield* runner.run(
        "other",
        Effect.andThen(record("other"), Deferred.succeed(otherRan, undefined)).pipe(Effect.asVoid),
      );
      yield* Deferred.await(otherRan);
      assert.deepStrictEqual(yield* Ref.get(events), ["other"]);

      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(busyRan);
      assert.deepStrictEqual(yield* Ref.get(events), ["other", "busy:1", "busy:2", "busy:3"]);
    }),
  );

  it.effect("runs the effect in the caller's scope", () =>
    Effect.gen(function* () {
      const lock = yield* KeyedLock.make<string>();
      const finalized = yield* Ref.make(false);
      const callerScope = yield* Scope.make();

      yield* lock
        .withLock(
          "key",
          Effect.addFinalizer(() => Ref.set(finalized, true)),
        )
        .pipe(Scope.provide(callerScope));
      assert.isFalse(yield* Ref.get(finalized));
      yield* Scope.close(callerScope, Exit.void);
      assert.isTrue(yield* Ref.get(finalized));
    }),
  );
});
