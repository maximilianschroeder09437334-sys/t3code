import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { useRef, useState } from "react";
import * as Dialog from "../../components/ui/Dialog";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { waitForThreadShellReady } from "./threadForkNavigation";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import { useSideChats } from "../../state/entities";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

export function ThreadSideChatsRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly canCreate: boolean;
}) {
  const sideChats = useSideChats({ environmentId: props.environmentId, threadId: props.threadId });
  const openLinkedThread = useOpenLinkedThread();
  const forkSideChat = useAtomCommand(threadEnvironment.forkSideChat, { reportFailure: false });
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (!props.canCreate || pending.current) return;
    pending.current = true;
    setBusy(true);
    await (async () => {
      const targetThreadId = ThreadId.make(uuidv4());
      const result = await forkSideChat({
        environmentId: props.environmentId,
        input: {
          sourceThreadId: props.threadId,
          targetThreadId,
          title: "Side chat",
          creationSource: "mobile",
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result))
          Dialog.alert("Could not start side chat", "Check the connection and try again.");
        return;
      }
      const atom = environmentThreadShells.threadShellAtom(
        scopeThreadRef(props.environmentId, targetThreadId),
      );
      const ready = await waitForThreadShellReady({
        read: () => appAtomRegistry.get(atom) !== null,
      });
      if (!ready) {
        Dialog.alert(
          "Side chat created",
          "Its data has not reached this device yet. Reconnect and open it from the side chats list.",
        );
        return;
      }
      openLinkedThread({ environmentId: props.environmentId, threadId: targetThreadId });
    })().catch(() => {
      Dialog.alert("Could not open side chat", "Check the side chats list and try again.");
    });
    pending.current = false;
    setBusy(false);
  };
  if (sideChats.length === 0 && !props.canCreate) return null;
  return (
    <View className="flex-row items-center gap-2 pb-2 pl-4">
      <SymbolView
        name="bubble.left.and.bubble.right"
        size={12}
        tintColorClassName="accent-foreground-muted"
      />
      <Text className="text-xs text-foreground-muted">Side chats</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} className="flex-1">
        <View className="flex-row gap-1 pr-4">
          {props.canCreate ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="New side chat"
              disabled={busy}
              onPress={() => void create()}
              className="rounded-full bg-subtle px-3 py-1 disabled:opacity-50"
            >
              <Text className="text-xs text-foreground">{busy ? "Opening..." : "+ New"}</Text>
            </Pressable>
          ) : null}
          {sideChats.map((sideChat) => {
            const needs =
              sideChat.hasPendingApprovals || sideChat.pendingSubagentRequest === "approval"
                ? "approval"
                : sideChat.hasPendingUserInput || sideChat.pendingSubagentRequest
                  ? "input"
                  : null;
            return (
              <Pressable
                key={sideChat.id}
                accessibilityRole="button"
                accessibilityLabel={`Open side chat ${sideChat.title}${needs === null ? "" : `, needs ${needs}`}`}
                className="max-w-48 flex-row items-center gap-1.5 rounded-full bg-subtle px-2.5 py-1"
                onPress={() =>
                  openLinkedThread({ environmentId: props.environmentId, threadId: sideChat.id })
                }
              >
                {needs === null ? null : (
                  <View
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      needs === "approval" ? "bg-warning-foreground" : "bg-adaptive-indigo-600-300",
                    )}
                  />
                )}
                <Text className="shrink text-xs text-foreground" numberOfLines={1}>
                  {sideChat.title}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}
