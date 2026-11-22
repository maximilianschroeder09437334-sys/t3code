import * as Notifications from "expo-notifications";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { AtomRegistry } from "effect/reactivity";

import { environmentThreadShells } from "../../state/threads";
import { isAppActive } from "../../lib/appState";
import { agentNotificationThreadOnScreen } from "./notificationNavigation";
import {
  classifyHomeThreadNotification,
  isNewHomeNotificationEntry,
  type HomeNotificationEvent,
} from "./homeNotificationState";

function deepLink(thread: EnvironmentThreadShell): string {
  return `/threads/${encodeURIComponent(thread.environmentId)}/${encodeURIComponent(thread.id)}`;
}

/** Uses live shell updates for silent local alerts; no permission prompt or native push setup. */
export function installHomeNotifications(registry: AtomRegistry.AtomRegistry): () => void {
  const previous = new Map<string, HomeNotificationEvent | null>();
  let firstSnapshot = true;
  const stop = registry.subscribe(
    environmentThreadShells.threadShellsAtom,
    (threads) => {
      const now = Date.now();
      const next = new Map<string, HomeNotificationEvent | null>();
      for (const thread of threads) {
        const key = `${thread.environmentId}\u0001${thread.id}`;
        const event = classifyHomeThreadNotification(thread, now);
        next.set(key, event);
        const prior = previous.get(key) ?? null;
        if (
          event === null ||
          firstSnapshot ||
          !isNewHomeNotificationEntry(prior, event, previous.has(key))
        )
          continue;
        const target = deepLink(thread);
        if (isAppActive() && agentNotificationThreadOnScreen() === target) continue;
        void Notifications.getPermissionsAsync()
          .then((permission) => {
            if (!permission.granted) return;
            return Notifications.scheduleNotificationAsync({
              content: {
                title: thread.title,
                body: event.body,
                data: { deepLink: target },
              },
              trigger: null,
            });
          })
          .catch(() => undefined);
      }
      previous.clear();
      for (const [key, event] of next) previous.set(key, event);
      firstSnapshot = false;
    },
    { immediate: true },
  );
  return stop;
}
