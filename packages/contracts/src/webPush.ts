import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
export const WebPushSubscription = Schema.Struct({
  endpoint: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  keys: Schema.Struct({
    p256dh: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
    auth: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  }),
  label: Schema.optional(Schema.String.check(Schema.isMaxLength(80))),
});
export type WebPushSubscription = typeof WebPushSubscription.Type;
export const WebPushInfo = Schema.Struct({
  publicKey: Schema.NullOr(Schema.String),
  subscriptions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      label: Schema.String,
      enabled: Schema.Boolean,
      lastStatus: Schema.NullOr(Schema.Number),
    }),
  ),
});
export type WebPushInfo = typeof WebPushInfo.Type;
export class WebPushError extends Schema.TaggedError<WebPushError>()("WebPushError", {
  reason: Schema.Literals(["storage", "endpoint", "not-found", "delivery", "rate-limited"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    switch (this.reason) {
      case "endpoint":
        return "Use a valid HTTPS subscription from a supported browser push service.";
      case "not-found":
        return "This browser's push subscription was not found. Enable notifications on this device again.";
      case "delivery":
        return "The push service did not accept the notification. Check the delivery status and reconnect this device if needed.";
      case "rate-limited":
        return "A test was recently queued. Wait a minute before sending another.";
      case "storage":
        return "Notification registration could not be read or saved.";
    }
  }
}
