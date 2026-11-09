import { expect, it } from "@effect/vitest";
import { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HookAutomation from "./HookAutomation.ts";
import { runHookedHandoff } from "./HookHandoffGateway.ts";

it.effect("blocks before delivery and never loses an actual receipt to an observer failure", () =>
  Effect.gen(function* () {
    const owner = {
      projectId: ProjectId.make("handoff-project"),
      threadId: ThreadId.make("handoff-thread"),
      runId: RunId.make("handoff-run"),
    };
    let delivered = 0;
    let allow = false;
    const delivery = Effect.sync(() => {
      delivered++;
      return { delivery: "queued" };
    });
    const layer = Layer.mock(HookAutomation.HookAutomation)({
      emit: (_, event) =>
        event === "before_handoff"
          ? Effect.sync(() => ({ allowed: allow, messages: ["Use a complete handoff"] }))
          : Effect.die("Observer failed after delivery"),
    });
    const send = runHookedHandoff(owner, { text: "A bounded task" }, delivery).pipe(
      Effect.provide(layer),
    );
    expect((yield* Effect.exit(send))._tag).toBe("Failure");
    expect(delivered).toBe(0);
    allow = true;
    expect(yield* send).toEqual({ delivery: "queued" });
    expect(delivered).toBe(1);
  }),
);
