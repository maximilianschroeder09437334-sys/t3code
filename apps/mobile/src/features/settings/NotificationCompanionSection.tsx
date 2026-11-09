import { useRef, useState } from "react";
import { Linking, Platform, View } from "react-native";
import {
  AuthAccessWriteScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  type EnvironmentId,
} from "@t3tools/contracts";
import { createAuthEnvironmentAtoms } from "@t3tools/client-runtime/state/auth";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  notificationCompanionOrigin,
  notificationCompanionPairingUrl,
} from "@t3tools/shared/notificationCompanion";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import { SettingsSection } from "./components/SettingsSection";

const companionAuth = createAuthEnvironmentAtoms(connectionAtomRuntime);
const companionScopes = [AuthOrchestrationReadScope, AuthSettingsWriteScope];

export function NotificationCompanionSection() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const { savedConnectionsById } = useSavedRemoteConnections();
  return (
    <View className="gap-3">
      <SettingsSection title="Home Screen notification companion">
        <View className="gap-3 px-4 py-4">
          <Text className="text-base text-foreground">
            Direct replies, input requests and important agent pings can alert you. Routine updates
            in muted threads stay silent.
          </Text>
          <Text className="text-sm text-foreground-muted">
            {Platform.OS === "ios"
              ? "Open setup in Safari, use Share > Add to Home Screen, then open that icon. In General settings, enable the notification companion. iOS shows alerts under that Home Screen app's name. Tapping an alert opens T3 Code Maxi; iOS may need another tap on Open T3."
              : "Open setup in your browser and install it on the Home Screen, then enable the notification companion in General settings. Background alerts belong to that Home Screen app."}
          </Text>
        </View>
      </SettingsSection>
      {selectedTargets.map((target) => {
        const connection = savedConnectionsById[target.environmentId];
        const origin = connection?.relayManaged
          ? null
          : notificationCompanionOrigin(connection?.httpBaseUrl ?? "");
        return (
          <CompanionEnvironment
            key={target.environmentId}
            environmentId={target.environmentId}
            label={target.label}
            origin={origin}
            serverSupported={
              target.serverConfig.environment.capabilities.webPushNotifications === true
            }
          />
        );
      })}
      {selectedTargets.length === 0 ? (
        <Text className="text-sm text-foreground-muted">
          Connect an environment to set up its notification companion.
        </Text>
      ) : null}
    </View>
  );
}

function CompanionEnvironment(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly origin: string | null;
  readonly serverSupported: boolean;
}) {
  const { environmentId, origin, serverSupported } = props;
  const canCreateLink = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const canReadThreads = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const canManageSettings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const enabled =
    serverSupported && origin !== null && canCreateLink && canReadThreads && canManageSettings;
  const openSetup = async () => {
    if (
      inFlight.current ||
      !enabled ||
      origin === null ||
      ![AuthAccessWriteScope, ...companionScopes].every((scope) =>
        readEnvironmentScope(environmentId, scope),
      )
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    const resultMessage = await openCompanionSetup(environmentId, origin);
    inFlight.current = false;
    setBusy(false);
    setMessage(resultMessage);
  };
  return (
    <SettingsSection title={props.label}>
      <View className="gap-3 px-4 py-4">
        <Text className="text-sm text-foreground-muted">
          {!serverSupported
            ? "Update this server to support companion notifications."
            : origin === null
              ? "Enable Tailscale HTTPS on your PC in Settings > Sharing & access, then connect this app through that HTTPS address."
              : !canCreateLink || !canReadThreads || !canManageSettings
                ? "This connection cannot create setup links. Ask the server owner for a browser pairing link."
                : origin}
        </Text>
        <Button
          tone="secondary"
          disabled={!enabled}
          loading={busy}
          label="Open setup in browser"
          onPress={() => void openSetup()}
        />
        {message !== null ? (
          <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
            {message}
          </Text>
        ) : null}
      </View>
    </SettingsSection>
  );
}

async function openCompanionSetup(environmentId: EnvironmentId, origin: string): Promise<string> {
  let issuedId: string | null = null;
  try {
    const result = await runAtomCommand(
      appAtomRegistry,
      companionAuth.createPairingCredential,
      {
        environmentId,
        input: { label: "Notification companion", scopes: companionScopes },
      },
      { reportFailure: false },
    );
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    issuedId = result.value.id;
    // Use the product's one-time browser flow; never copy the native app's access token.
    await Linking.openURL(notificationCompanionPairingUrl(origin, result.value.credential));
    return "Setup opened in your browser. Alerts start after you add the Home Screen app and enable notifications there.";
  } catch (error) {
    if (issuedId !== null)
      await runAtomCommand(appAtomRegistry, companionAuth.revokePairingLink, {
        environmentId,
        input: { id: issuedId },
      }).catch(() => undefined);
    return error instanceof Error
      ? error.message
      : "Could not open setup. Try again from this page.";
  }
}
