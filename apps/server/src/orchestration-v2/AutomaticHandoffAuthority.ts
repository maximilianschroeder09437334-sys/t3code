import type { RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

interface Binding {
  readonly threadId: ThreadId;
  readonly requestId: RuntimeRequestId;
  readonly generation: string;
}

const Authority = Context.Reference<Binding | undefined>(
  "t3/orchestration-v2/AutomaticHandoffAuthority",
  { defaultValue: () => undefined },
);

export const automaticHandoffAuthority = Effect.service(Authority);

/** Only the host readiness producer supplies this context. It is never decoded from RPC input. */
export const withAutomaticHandoffAuthority = <A, E, R>(
  binding: Binding,
  effect: Effect.Effect<A, E, R>,
) => effect.pipe(Effect.provideService(Authority, binding));
