import { useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { MessageId, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { launchImageLibraryAsync } from "expo-image-picker";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import { useMemo, useState } from "react";
import { Image, Modal, Pressable, ScrollView, TextInput, View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAssetUrl } from "../../state/assets";
import { uuidv4 } from "../../lib/uuid";
import { threadNotePersistScreenshot, threadNotesDelete, threadNotesRead, threadNotesSave } from "../../state/thread-notes";

export function ThreadNotesSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly visible: boolean;
  readonly onClose: () => void;
}) {
  const [content, setContent] = useState("");
  const [attachment, setAttachment] = useState<{ readonly type: "image"; readonly id: string; readonly name: string; readonly mimeType: string; readonly sizeBytes: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = useMemo(() => threadNotesRead({ environmentId: props.environmentId, input: { threadId: props.threadId } }), [props.environmentId, props.threadId]);
  const result = useAtomValue(query);
  const notes = result._tag === "Success" ? result.value.notes : [];
  const canWrite = useAtomValue(threadNotesSave.permissionAtom(props.environmentId));
  const pickScreenshot = async () => {
    const picked = await launchImageLibraryAsync({ mediaTypes: ["images"], base64: true, quality: 1 });
    const image = picked.canceled ? undefined : picked.assets[0];
    if (!image) return;
    const png = await manipulateAsync(image.uri, [], { format: SaveFormat.PNG, base64: true });
    if (!png.base64) { setError("Could not prepare this screenshot."); return; }
    const padding = png.base64.endsWith("==") ? 2 : png.base64.endsWith("=") ? 1 : 0;
    setBusy(true);
    setError(null);
    const uploaded = await runAtomCommand(appAtomRegistry, threadNotePersistScreenshot, {
      environmentId: props.environmentId,
      input: {
        threadId: props.threadId,
        messageId: MessageId.make(uuidv4()),
        attachments: [{ type: "image", name: "screenshot.png", mimeType: "image/png", sizeBytes: png.base64.length * 3 / 4 - padding, dataUrl: `data:image/png;base64,${png.base64}` }],
      },
    });
    setBusy(false);
    const persisted = uploaded._tag === "Success" ? uploaded.value.attachments[0] : undefined;
    if (!persisted || persisted.type !== "image") {
      setError("Screenshot upload failed.");
      return;
    }
    setAttachment({ type: "image", id: persisted.id, name: persisted.name, mimeType: persisted.mimeType, sizeBytes: persisted.sizeBytes });
  };
  const save = async () => {
    if (!content.trim() || busy) return;
    setBusy(true);
    setError(null);
    const saved = await runAtomCommand(appAtomRegistry, threadNotesSave, {
      environmentId: props.environmentId,
      input: { threadId: props.threadId, requestId: uuidv4(), content, ...(attachment ? { attachments: [attachment] } : {}) },
    });
    setBusy(false);
    if (saved._tag !== "Success") { setError("Could not save this note."); return; }
    setContent("");
    setAttachment(null);
    void appAtomRegistry.refresh(query);
  };

  return (
    <Modal visible={props.visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={props.onClose}>
      <View className="flex-1 bg-background px-4 pt-4">
        <View className="flex-row items-center justify-between pb-3">
          <AppText className="text-lg font-semibold">Thread notes</AppText>
          <Pressable accessibilityRole="button" onPress={props.onClose}><AppText>Done</AppText></Pressable>
        </View>
        <ScrollView className="flex-1" contentContainerStyle={{ gap: 12, paddingBottom: 16 }}>
          {notes.map((note) => (
            <View key={note.requestId} className="rounded-lg border border-border p-3">
              <AppText>{note.content}</AppText>
              {note.attachments.map((saved) => <ThreadNoteImage key={saved.id} environmentId={props.environmentId} attachmentId={saved.id} name={saved.name} />)}
              <Pressable accessibilityRole="button" disabled={!canWrite} onPress={async () => {
                const removed = await runAtomCommand(appAtomRegistry, threadNotesDelete, { environmentId: props.environmentId, input: { threadId: props.threadId, requestId: note.requestId } });
                if (removed._tag === "Success") void appAtomRegistry.refresh(query);
              }}><AppText className="pt-2 text-destructive">Delete note</AppText></Pressable>
            </View>
          ))}
          {notes.length === 0 ? <AppText className="text-foreground-muted">No notes saved for this thread.</AppText> : null}
        </ScrollView>
        <TextInput multiline value={content} onChangeText={setContent} placeholder="Important decision, preference, or lasting constraint…" className="min-h-24 rounded-lg border border-border p-3 text-foreground" />
        {attachment ? <AppText className="py-2 text-foreground-muted">Screenshot attached: {attachment.name}</AppText> : null}
        {error ? <AppText accessibilityRole="alert" className="py-2 text-destructive">{error}</AppText> : null}
        <View className="flex-row justify-between py-3">
          <Pressable accessibilityRole="button" disabled={!canWrite || busy} onPress={() => void pickScreenshot()}><AppText>Add screenshot</AppText></Pressable>
          <Pressable accessibilityRole="button" disabled={!canWrite || busy || !content.trim()} onPress={() => void save()}><AppText className="font-semibold">Save note</AppText></Pressable>
        </View>
      </View>
    </Modal>
  );
}

function ThreadNoteImage(props: { readonly environmentId: EnvironmentId; readonly attachmentId: string; readonly name: string }) {
  const url = useAssetUrl(props.environmentId, { _tag: "attachment", attachmentId: props.attachmentId });
  return url ? <Image source={{ uri: url }} accessibilityLabel={props.name} resizeMode="contain" className="mt-2 h-44 w-full rounded-lg" /> : null;
}
