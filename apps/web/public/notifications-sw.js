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
  const path = event.notification.data?.path ?? "/";
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) return;
  const destination = new URL(path, self.location.origin);
  if (destination.origin !== self.location.origin || destination.search || destination.hash) return;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
      const existing = windows.find(
        (client) => new URL(client.url).origin === self.location.origin,
      );
      if (existing) {
        try {
          const navigated = await existing.navigate(destination.href);
          if (navigated) return await navigated.focus();
        } catch {
          // A window can close after matchAll; opening a new one still delivers the chat.
        }
      }
      // Legacy ?nativeApp=maxi registrations now stay in the full Home Screen app too.
      const opened = await self.clients.openWindow(destination.href);
      if (opened && destination.pathname !== "/") {
        const actual = new URL(opened.url, self.location.origin);
        // Some OS launches land at the manifest start URL. Correct that once, without a loop.
        if (actual.origin === self.location.origin && actual.pathname === "/") {
          const navigated = await opened.navigate(destination.href);
          if (navigated) return navigated.focus();
        }
      }
      return opened;
    }),
  );
});
