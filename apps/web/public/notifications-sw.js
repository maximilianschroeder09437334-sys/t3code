self.addEventListener("push", (event) => {
  let message;
  try {
    message = event.data?.json();
  } catch {
    message = null;
  }
  const title = typeof message?.title === "string" ? message.title : "T3 Code update";
  const path =
    typeof message?.path === "string" &&
    message.path.startsWith("/") &&
    !message.path.startsWith("//")
      ? message.path
      : "/";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof message?.body === "string" ? message.body : "An agent needs your attention.",
      tag: typeof message?.tag === "string" ? message.tag : "t3-attention",
      icon: "/icon-192x192.png",
      badge: "/favicon-32x32.png",
      data: { path },
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  let destination = new URL(event.notification.data?.path ?? "/", self.location.origin);
  if (destination.origin !== self.location.origin) return;
  if (new URL(self.location.href).searchParams.get("nativeApp") === "maxi") {
    const handoff = new URL("/notification-open.html", self.location.origin);
    handoff.hash = new URLSearchParams({ path: destination.pathname }).toString();
    destination = handoff;
  }
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
      const existing = windows.find(
        (client) => new URL(client.url).origin === self.location.origin,
      );
      if (existing) {
        await existing.navigate(destination.href);
        return existing.focus();
      }
      return self.clients.openWindow(destination.href);
    }),
  );
});
