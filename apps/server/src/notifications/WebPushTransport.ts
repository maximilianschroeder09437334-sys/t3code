// @effect-diagnostics nodeBuiltinImport:off -- Web Push uses Node's HTTPS transport through the upstream library.
import * as WebPush from "web-push";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { WebPushError, type WebPushSubscription } from "@t3tools/contracts";
export const VapidKeys = Schema.Struct({ publicKey: Schema.String, privateKey: Schema.String });
export type VapidKeys = typeof VapidKeys.Type;
export class WebPushTransport extends Context.Service<
  WebPushTransport,
  {
    readonly generateKeys: Effect.Effect<VapidKeys>;
    readonly send: (input: {
      readonly subscription: WebPushSubscription;
      readonly keys: VapidKeys;
      readonly payload: string;
      readonly topic: string;
    }) => Effect.Effect<number, WebPushError>;
  }
>()("t3/notifications/WebPushTransport") {}
export const layer = Layer.succeed(WebPushTransport, {
  generateKeys: Effect.sync(() => WebPush.generateVAPIDKeys()),
  send: Effect.fn("WebPushTransport.send")(function (input) {
    return Effect.tryPromise({
      try: () =>
        WebPush.sendNotification(input.subscription, input.payload, {
          vapidDetails: { subject: "https://t3.codes", ...input.keys },
          contentEncoding: "aes128gcm",
          TTL: 120,
          urgency: "normal",
          topic: input.topic,
          timeout: 10_000,
        }),
      catch: (cause) => new WebPushError({ reason: "delivery", cause }),
    }).pipe(
      Effect.matchEffect({
        onFailure: (error) => {
          const cause = error.cause;
          return typeof cause === "object" &&
            cause !== null &&
            "statusCode" in cause &&
            typeof cause.statusCode === "number"
            ? Effect.succeed(cause.statusCode)
            : Effect.fail(error);
        },
        onSuccess: (response) => Effect.succeed(response.statusCode),
      }),
    );
  }),
});
