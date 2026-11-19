import { useAtomValue } from "@effect/atom-react";
import type { StaticScreenProps } from "@react-navigation/native";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ThreadId, WS_METHODS } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { connectionAtomRuntime } from "../../connection/runtime";
import { SettingsScreen } from "../settings/components/SettingsScreen";

const notesQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile-thread-notes:read",
  tag: WS_METHODS.threadNotesRead,
  staleTimeMs: 0,
});

export function ThreadNotesRouteScreen({
  route,
}: StaticScreenProps<{ environmentId: string; threadId: string }>) {
  const result = useAtomValue(
    notesQuery({
      environmentId: EnvironmentId.make(route.params.environmentId),
      input: { threadId: ThreadId.make(route.params.threadId) },
    }),
  );
  return (
    <SettingsScreen title="Thread notes">
      <ScreenScrollView contentContainerClassName="gap-4 px-4 py-4">
        {AsyncResult.isFailure(result) ? (
          <Text accessibilityRole="alert">
            Thread notes are unavailable. Go back and reopen to retry.
          </Text>
        ) : AsyncResult.isSuccess(result) ? (
          <View className="gap-4">
            {result.value.notes.length === 0 ? <Text>No saved notes for this thread.</Text> : null}
            {result.value.notes.map((note) => (
              <View key={note.requestId} className="gap-2 border-b border-border pb-4">
                <Text className="text-xs text-foreground-muted">{note.createdAt}</Text>
                <Text selectable>{note.content}</Text>
                {note.attachments.length > 0 ? (
                  <Text className="text-xs text-foreground-muted">
                    {note.attachments.length} saved attachments
                  </Text>
                ) : null}
              </View>
            ))}
            {result.value.truncated ? (
              <Text>Showing recent notes; older notes remain saved.</Text>
            ) : null}
          </View>
        ) : (
          <Text>Loading notes…</Text>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
