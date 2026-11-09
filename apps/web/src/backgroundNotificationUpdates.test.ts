import { expect, it } from "vite-plus/test";
import { updateNotificationWorkers } from "./backgroundNotificationUpdates";

it("updates existing notification scopes without touching other app workers or other origins", async () => {
  const updated: string[] = [];
  const scopes = [
    "https://t3.test/notifications/env-one/",
    "https://t3.test/notifications/env-two/",
    "https://t3.test/",
    "https://t3.test/notifications-other/",
    "https://elsewhere.test/notifications/env/",
  ];
  const registrations = scopes.map((scope) => ({
    scope,
    update: async () => {
      updated.push(scope);
      return {} as ServiceWorkerRegistration;
    },
  }));
  await updateNotificationWorkers(registrations, "https://t3.test");
  expect(updated).toEqual(scopes.slice(0, 2));
});

it("keeps other environments updating when one worker throws during a refresh", async () => {
  let refreshed = false;
  await updateNotificationWorkers(
    [
      {
        scope: "https://t3.test/notifications/broken/",
        update: () => {
          throw new Error("Offline");
        },
      },
      {
        scope: "https://t3.test/notifications/working/",
        update: async () => {
          refreshed = true;
          return {} as ServiceWorkerRegistration;
        },
      },
    ],
    "https://t3.test",
  );
  expect(refreshed).toBe(true);
});
