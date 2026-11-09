import { expect, it } from "vite-plus/test";
import {
  isWebPushOrigin,
  notificationCompanionOrigin,
  notificationCompanionPairingUrl,
} from "./notificationCompanion.ts";

it("refuses Electron's secure custom origin before attempting service-worker registration", () => {
  expect(isWebPushOrigin("t3code:", true)).toBe(false);
  expect(isWebPushOrigin("file:", true)).toBe(false);
  expect(isWebPushOrigin("https:", true)).toBe(true);
  expect(isWebPushOrigin("http:", true)).toBe(true);
  expect(isWebPushOrigin("http:", false)).toBe(false);
});

it("opens the direct HTTPS pairing route with a one-time fragment instead of native credentials", () => {
  const endpoint = "https://host.example.test/?token=old-query#token=old-fragment";
  expect(notificationCompanionOrigin(endpoint)).toBe("https://host.example.test");
  const pairing = new URL(notificationCompanionPairingUrl(endpoint, "one-time-only"));
  expect(pairing.origin).toBe("https://host.example.test");
  expect(pairing.pathname).toBe("/pair");
  expect(pairing.search).toBe("");
  expect(new URLSearchParams(pairing.hash.slice(1)).get("token")).toBe("one-time-only");
  for (const unsafe of [
    "http://host.example.test",
    "t3code://app",
    "not a url",
    "https://user:password@host.example.test/",
    "https://relay.example.test/environments/server",
  ]) {
    expect(notificationCompanionOrigin(unsafe)).toBeNull();
    expect(() => notificationCompanionPairingUrl(unsafe, "one-time-only")).toThrow();
  }
});
