import type { CommandId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

export const CurrentHandoffProviderStart = Context.Reference<
  Effect.Effect<void, ProviderAdapter.ProviderAdapterV2Error> | undefined
>("t3/handoff-transfer/before-provider-start", { defaultValue: () => undefined });

export const HandoffProviderSessionWrite = Context.Reference<
  { readonly commandId: CommandId; readonly threadId: ThreadId } | undefined
>("t3/handoff-transfer/provider-session-write", { defaultValue: () => undefined });
