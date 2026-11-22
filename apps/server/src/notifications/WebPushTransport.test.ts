// @effect-diagnostics nodeBuiltinImport:off -- Generates ephemeral cryptographic fixtures for Web Push.
import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import * as WebPush from "web-push";
import { createEncryptedPushRequest } from "./WebPushTransport.ts";

function isValidVapidSignature(authorization: string, publicKey: string): boolean {
  const token = /^vapid t=([^,]+), k=([^,]+)$/u.exec(authorization)?.[1];
  if (token === undefined) return false;
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) return false;
  const point = Buffer.from(publicKey, "base64url");
  const key = NodeCrypto.createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33, 65).toString("base64url"),
    },
    format: "jwk",
  });
  return NodeCrypto.verify(
    "sha256",
    Buffer.from(`${header}.${payload}`),
    { key, dsaEncoding: "ieee-p1363" },
    Buffer.from(signature, "base64url"),
  );
}

it("builds a VAPID-authenticated aes128gcm request without contacting a push service", () => {
  const subscriberKeys = NodeCrypto.createECDH("prime256v1");
  subscriberKeys.generateKeys();
  const subscription = {
    endpoint: "https://web.push.apple.com/mock-endpoint",
    keys: {
      p256dh: subscriberKeys.getPublicKey().toString("base64url"),
      auth: NodeCrypto.randomBytes(16).toString("base64url"),
    },
  };
  const keys = WebPush.generateVAPIDKeys();
  const payload = JSON.stringify({
    title: "Build needs you",
    body: "Maxi: review the build",
    path: "/environment/thread",
  });
  const request = createEncryptedPushRequest({
    subscription,
    keys,
    payload,
    topic: "home-needs-you",
  });
  const authorization = request.headers.Authorization;
  if (authorization === undefined) throw new Error("Missing VAPID authorization header");

  expect(request.endpoint).toBe(subscription.endpoint);
  expect(authorization).toMatch(/^vapid t=.+, k=.+$/u);
  expect(isValidVapidSignature(authorization, keys.publicKey)).toBe(true);
  expect(request.headers["Content-Encoding"]).toBe("aes128gcm");
  expect(request.headers["Content-Type"]).toBe("application/octet-stream");
  expect(request.body).toBeInstanceOf(Buffer);
  expect(request.body.length).toBeGreaterThan(payload.length);
  expect(request.body.includes(Buffer.from(payload))).toBe(false);
});
