import { isWebPushOrigin } from "@t3tools/shared/notificationCompanion";

type Registration = Pick<ServiceWorkerRegistration, "scope" | "update">;

export async function updateNotificationWorkers(
  registrations: readonly Registration[],
  origin: string,
) {
  await Promise.allSettled(
    registrations
      .filter((registration) => registration.scope.startsWith(origin + "/notifications/"))
      .map(async (registration) => registration.update()),
  );
}

/** Refresh only existing push workers; never register devices or request permission at startup. */
export function startBackgroundNotificationUpdates(): () => void {
  if (
    !isWebPushOrigin(window.location.protocol, window.isSecureContext) ||
    !("serviceWorker" in navigator)
  )
    return () => {};
  let stopped = false;
  let busy = false;
  let checkedAt = Number.NEGATIVE_INFINITY;
  const refresh = async () => {
    if (
      stopped ||
      busy ||
      document.visibilityState !== "visible" ||
      Date.now() - checkedAt < 5 * 60_000
    )
      return;
    busy = true;
    checkedAt = Date.now();
    try {
      await updateNotificationWorkers(
        await navigator.serviceWorker.getRegistrations(),
        window.location.origin,
      );
    } catch {
      // Keep the working registration on a network failure. Refresh notifications in Settings reports setup errors.
    } finally {
      busy = false;
    }
  };
  const onVisible = () => void refresh();
  window.addEventListener("focus", onVisible);
  document.addEventListener("visibilitychange", onVisible);
  onVisible();
  return () => {
    stopped = true;
    window.removeEventListener("focus", onVisible);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
