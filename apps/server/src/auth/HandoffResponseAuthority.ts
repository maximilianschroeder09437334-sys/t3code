import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { AuthenticatedSession } from "./EnvironmentAuth.ts";
const Authority = Context.Reference<boolean>("t3/auth/HandoffResponseAuthority", {
  defaultValue: () => false,
});
export const hasHandoffResponseAuthority = Effect.service(Authority);
// Only the authenticated RPC closure supplies this context; commands never decode it.
export const withAuthenticatedHandoffResponse = <A, E, R>(
  session: AuthenticatedSession,
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.provideService(
      Authority,
      session.subject !== "mcp-client" && session.scopes.includes(AuthOrchestrationOperateScope),
    ),
  );
