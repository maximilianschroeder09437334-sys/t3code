import { useServerConfigs } from "~/state/entities";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  webPushInfo,
  webPushPrepare,
  webPushSubscribe,
  webPushTest,
  webPushUnsubscribe,
} from "~/state/webPush";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

function applicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const text = atob(
    value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4),
  );
  return Uint8Array.from(text, (character) => character.charCodeAt(0));
}
export function WebPushNotifications() {
  const { target } = useSettingsScope();
  const primary = usePrimaryEnvironmentId();
  const environmentId = target?.environmentId ?? primary;
  return environmentId === null ? null : (
    <DeviceWebPush key={environmentId} environmentId={environmentId} />
  );
}
function DeviceWebPush({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const serverSupported =
    useServerConfigs().get(environmentId)?.environment.capabilities.webPushNotifications === true;
  const info = useEnvironmentQuery(
    serverSupported ? webPushInfo({ environmentId, input: undefined }) : null,
  );
  const prepare = useAtomCommand(webPushPrepare);
  const subscribe = useAtomCommand(webPushSubscribe);
  const unsubscribe = useAtomCommand(webPushUnsubscribe);
  const test = useAtomCommand(webPushTest);
  const canSubscribe = useAtomValue(webPushSubscribe.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(() =>
    localStorage.getItem(`t3:web-push:${environmentId}`),
  );
  const supported =
    serverSupported &&
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    ("standalone" in navigator && navigator.standalone === true);
  const isAppleMobile =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const enable = async () => {
    if (busy || !canSubscribe || !supported) return;
    setBusy(true);
    setMessage(null);
    try {
      // iPad requires the permission request to begin in this direct click handler.
      const permission = await Notification.requestPermission();
      if (permission !== "granted")
        throw new Error(
          "Allow notifications for this Home Screen app in iPad Settings, then try again.",
        );
      const configured = await prepare({ environmentId, input: undefined });
      if (configured._tag === "Failure")
        throw new Error(String(squashAtomCommandFailure(configured)));
      const registration = await navigator.serviceWorker.register(
        isAppleMobile ? "/notifications-sw.js?nativeApp=maxi" : "/notifications-sw.js",
        {
          scope: `/notifications/${encodeURIComponent(environmentId)}/`,
        },
      );
      // This registration need not control the current page. `ready` would wait
      // for a controlling worker and hang outside this environment's scope.
      if (registration.active === null) {
        const worker = registration.installing ?? registration.waiting;
        if (worker === null)
          throw new Error("The notification worker did not start. Try enabling again.");
        await new Promise<void>((resolve, reject) => {
          const changed = () => {
            if (worker.state === "activated" || worker.state === "redundant") {
              worker.removeEventListener("statechange", changed);
              if (worker.state === "activated") resolve();
              else reject(new Error("The notification worker could not activate. Try again."));
            }
          };
          worker.addEventListener("statechange", changed);
          changed();
        });
      }
      let browserSubscription = await registration.pushManager.getSubscription();
      const savedDevice = info.data?.subscriptions.find((value) => value.id === currentId);
      if (
        browserSubscription !== null &&
        (savedDevice?.lastStatus === 404 || savedDevice?.lastStatus === 410)
      ) {
        await browserSubscription.unsubscribe();
        browserSubscription = null;
      }
      if (browserSubscription === null)
        browserSubscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationServerKey(configured.value.publicKey),
        });
      const json = browserSubscription.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth)
        throw new Error("This browser did not return a complete push subscription.");
      const saved = await subscribe({
        environmentId,
        input: {
          endpoint: json.endpoint,
          keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
          label: "Home Screen companion",
        },
      });
      if (saved._tag === "Failure") throw new Error(String(squashAtomCommandFailure(saved)));
      localStorage.setItem(`t3:web-push:${environmentId}`, saved.value.id);
      setCurrentId(saved.value.id);
      setMessage(
        "Connected. Send a test and tap it to open T3 Code Maxi. iOS may ask you to confirm opening the app.",
      );
      info.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Notifications could not be enabled.");
    } finally {
      setBusy(false);
    }
  };
  const sendTest = async () => {
    if (currentId === null) return;
    setBusy(true);
    const result = await test({ environmentId, input: { id: currentId } });
    setBusy(false);
    setMessage(
      result._tag === "Success"
        ? "Test queued. Confirm the notification appears on this device."
        : String(squashAtomCommandFailure(result)),
    );
    info.refresh();
  };
  const disable = async () => {
    if (currentId === null) return;
    setBusy(true);
    const result = await unsubscribe({ environmentId, input: { id: currentId } });
    setBusy(false);
    if (result._tag === "Success") {
      localStorage.removeItem(`t3:web-push:${environmentId}`);
      setCurrentId(null);
      setMessage("Companion notifications disabled for this environment.");
      info.refresh();
    } else setMessage(String(squashAtomCommandFailure(result)));
  };
  return (
    <div>
      <SettingsRow
        title="Home Screen notification companion"
        description="Receive direct replies, input requests and important agent pings. Routine agent updates stay muted."
        control={
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy || !canSubscribe || !supported || (isAppleMobile && !standalone)}
              onClick={() => void enable()}
            >
              {busy ? "Working..." : "Enable on this device"}
            </Button>
            {currentId !== null ? (
              <>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => void sendTest()}>
                  Send test
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void disable()}>
                  Disable
                </Button>
              </>
            ) : null}
          </div>
        }
      />
      <div className="px-4 pb-4 text-sm text-muted-foreground">
        <span className="mt-2 block">
          On iPad, open this server through its HTTPS address, add it to the Home Screen, open that
          icon, then enable notifications here. On iPhone and iPad, notification taps open T3 Code
          Maxi through an app link; an Open T3 button remains available if iOS needs another tap.
        </span>
        {!supported ? (
          <span className="mt-2 block">
            Use an updated T3 server, a supported browser and a valid HTTPS connection.
          </span>
        ) : null}
        {isAppleMobile && !standalone ? (
          <span className="mt-2 block">
            Open the Home Screen icon to enable iPad push notifications.
          </span>
        ) : null}
        {message !== null ? (
          <span className="mt-2 block" role="status">
            {message}
          </span>
        ) : null}
        {info.error !== null ? (
          <span className="mt-2 block" role="alert">
            {info.error}
          </span>
        ) : null}
        {info.data?.subscriptions.find((value) => value.id === currentId)?.lastStatus === 201 ? (
          <span className="mt-2 block">
            The push service accepted the last notification. Confirm it appeared on this device.
          </span>
        ) : null}
        {[404, 410].includes(
          info.data?.subscriptions.find((value) => value.id === currentId)?.lastStatus ?? -1,
        ) ? (
          <span className="mt-2 block">
            This device registration expired. Enable it again to reconnect.
          </span>
        ) : null}
      </div>
    </div>
  );
}
