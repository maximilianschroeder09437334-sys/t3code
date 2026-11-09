import { setPairingTokenOnUrl } from "./remote.ts";

// Electron marks its custom origin secure, but Chromium only registers web workers on HTTP(S).
export function isWebPushOrigin(protocol: string, secureContext: boolean): boolean {
  return secureContext && (protocol === "https:" || protocol === "http:");
}

export function notificationCompanionOrigin(endpoint: string): string | null {
  try {
    const url = new URL(endpoint);
    // Relay API paths do not host the companion. It needs the server's direct HTTPS web route.
    return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

export function notificationCompanionPairingUrl(endpoint: string, credential: string): string {
  const origin = notificationCompanionOrigin(endpoint);
  if (origin === null) throw new Error("Set up a direct HTTPS address for this server first.");
  return setPairingTokenOnUrl(new URL("/pair", origin), credential).toString();
}
