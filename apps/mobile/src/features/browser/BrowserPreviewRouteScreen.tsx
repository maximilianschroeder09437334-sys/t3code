import { SheetHeader } from "../../components/ui/SheetHeader";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import * as Dialog from "../../components/ui/Dialog";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ThreadId, type PreviewSessionSnapshot } from "@t3tools/contracts";
import { normalizePreviewUrl, previewPdfAssetUrl } from "@t3tools/shared/preview";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { useRef, useState } from "react";
import { Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ControlPill } from "../../components/ui/ControlPill";
import { AppText } from "../../components/ui/AppText";
import { useContentTopInset } from "../../components/ui/useBarInset";
import { useAppForeground } from "../../lib/appState";

import { previewEnvironment, useThreadServerBrowserTabs } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";
import { usePreparedConnection } from "../../state/session";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { BrowserTabMenu } from "./BrowserTabMenu";
import {
  browserOpenErrorMessage,
  browserTabTitle,
  browserTabUrl,
  latestBrowserTab,
  normalizeBrowserAddressDraft,
} from "./browserTabs";
import {
  PreviewStreamWebView,
  type PreviewPictureInPictureState,
  type PreviewStreamRef,
} from "./PreviewStreamWebView";

const NO_PICTURE_IN_PICTURE: PreviewPictureInPictureState = { supported: false, active: false };

type BrowserPreviewRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly tabId?: string;
}>;

export function BrowserPreviewRouteScreen({ route }: BrowserPreviewRouteScreenProps) {
  const navigation = useNavigation();
  const onClose = () => navigation.goBack();
  const { environmentId, threadId } = route.params;
  if (!environmentId?.trim() || !threadId?.trim()) {
    return <BrowserUnavailableScreen onClose={onClose} />;
  }
  return (
    <BrowserPreviewScreen
      environmentId={EnvironmentId.make(environmentId)}
      threadId={ThreadId.make(threadId)}
      initialTabId={route.params.tabId ?? null}
      onClose={onClose}
      embedded={false}
    />
  );
}

export function BrowserPreviewInline(props: {
  readonly environmentId: string;
  readonly threadId: string;
}) {
  return (
    <BrowserPreviewScreen
      environmentId={EnvironmentId.make(props.environmentId)}
      threadId={ThreadId.make(props.threadId)}
      initialTabId={null}
      onClose={() => {}}
      embedded
    />
  );
}

function BrowserUnavailableScreen({ onClose }: { readonly onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const contentTopInset = useContentTopInset();
  return (
    <View
      className="flex-1 bg-sheet"
      style={{ paddingTop: contentTopInset, paddingBottom: insets.bottom }}
    >
      <SheetHeader title="Browser" onClose={onClose} accessibilityLabel="Close browser" />
    </View>
  );
}

function BrowserPreviewScreen({
  environmentId,
  threadId,
  initialTabId,
  onClose,
  embedded,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly initialTabId: string | null;
  readonly onClose: () => void;
  readonly embedded: boolean;
}) {
  const insets = useSafeAreaInsets();
  const contentTopInset = useContentTopInset();
  const { themeVariables } = useAppearancePreferences();
  const prepared = usePreparedConnection(environmentId);
  const httpBaseUrl = Option.isSome(prepared) ? prepared.value.httpBaseUrl : null;
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const [selectedTabId, setSelectedTabId] = useState(initialTabId);
  const [pictureInPicture, setPictureInPicture] = useState(NO_PICTURE_IN_PICTURE);
  const [streaming, setStreaming] = useState(false);
  const [canControl, setCanControl] = useState(false);
  const streamRef = useRef<PreviewStreamRef>(null);
  const openPreview = useAtomCommand(previewEnvironment.open, "open browser tab");
  const [emptyAddress, setEmptyAddress] = useState("");
  const [openingTab, setOpeningTab] = useState(false);
  const { tabs, loaded } = useThreadServerBrowserTabs({ environmentId, threadId, enabled: true });
  const tab = tabs.find((entry) => entry.tabId === selectedTabId) ?? latestBrowserTab(tabs);
  const pdfUri =
    tab?.navStatus._tag === "Success" ? previewPdfAssetUrl(tab.navStatus.url, httpBaseUrl) : null;
  const tabId = tab?.tabId ?? null;
  if (tabId !== null && tabId !== selectedTabId) {
    setPictureInPicture(NO_PICTURE_IN_PICTURE);
    setSelectedTabId(tabId);
  }
  const openAddress = async () => {
    if (openingTab) return;
    const url = normalizeBrowserAddressDraft(emptyAddress);
    if (url === null) {
      Dialog.alert("Could not open this address", "Enter an http or https URL.");
      return;
    }
    setOpeningTab(true);
    const result = await openPreview({ environmentId, input: { threadId, url } });
    setOpeningTab(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      Dialog.alert("Browser could not open this page", browserOpenErrorMessage(failure));
    }
  };
  const onPictureInPicture = (state: PreviewPictureInPictureState, detail?: string) => {
    setPictureInPicture({ supported: state.supported, active: state.active });
    if (detail) Dialog.alert("Picture in picture is unavailable", detail);
  };
  const selectTab = (next: string) => {
    setPictureInPicture(NO_PICTURE_IN_PICTURE);
    setSelectedTabId(next);
  };
  const live = (focused && foreground) || pictureInPicture.active;

  return (
    <View
      className="flex-1 bg-sheet"
      style={{ paddingTop: embedded ? 0 : contentTopInset, paddingBottom: insets.bottom }}
    >
      {embedded ? null : (
        <SheetHeader
          title={tab ? browserTabTitle(tab) : "Browser"}
          onClose={onClose}
          accessibilityLabel="Close browser"
          actions={
            // Android WebView cannot play video in picture in picture.
            Platform.OS === "ios" &&
            pictureInPicture.supported &&
            (pictureInPicture.active || pdfUri === null)
              ? [
                  {
                    accessibilityLabel: pictureInPicture.active
                      ? "Exit picture in picture"
                      : "Picture in picture",
                    icon: {
                      ios: pictureInPicture.active ? "pip.exit" : "pip.enter",
                      android: "visibility",
                    },
                    selected: pictureInPicture.active,
                    onPress: () => streamRef.current?.togglePictureInPicture(),
                  },
                ]
              : []
          }
          menus={
            tabs.length > 1
              ? [
                  {
                    title: "Tabs",
                    icon: "square.on.square",
                    items: tabs.map((entry) => ({
                      id: entry.tabId,
                      title: browserTabTitle(entry),
                      subtitle: browserTabUrl(entry),
                      selected: entry.tabId === tabId,
                      onPress: () => selectTab(entry.tabId),
                    })),
                  },
                ]
              : []
          }
        />
      )}
      {embedded && tabs.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          className="max-h-12 border-b border-border"
          contentContainerClassName="items-center gap-2 px-3 py-2"
        >
          {tabs.map((entry) => (
            <Pressable
              key={entry.tabId}
              accessibilityRole="button"
              accessibilityLabel={`Show ${browserTabTitle(entry)}`}
              accessibilityState={{ selected: entry.tabId === tabId }}
              onPress={() => selectTab(entry.tabId)}
              className={`rounded-full px-3 py-1.5 ${entry.tabId === tabId ? "bg-accent" : "bg-subtle"}`}
            >
              <AppText className="max-w-48 text-xs text-foreground">
                {browserTabTitle(entry)}
              </AppText>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      {tab ? (
        <>
          <BrowserAddressBar
            key={`address:${tab.tabId}`}
            environmentId={environmentId}
            tab={tab}
            streaming={streaming}
            ready={streaming && canControl}
            onCommand={(input) => streamRef.current?.command(input)}
            onPaste={() => streamRef.current?.paste()}
          />
          {live ? (
            <PreviewStreamWebView
              key={`stream:${tab.tabId}`}
              environmentId={environmentId}
              threadId={threadId}
              tabId={tab.tabId}
              pdfUri={pdfUri}
              ref={streamRef}
              interactive
              background={themeVariables["--color-sheet-solid"]}
              onPictureInPicture={onPictureInPicture}
              onStreamingChange={setStreaming}
              onControl={(control) => setCanControl(control?.controller === "you")}
            />
          ) : (
            <View className="flex-1" />
          )}
        </>
      ) : (
        <View className="flex-1 justify-center gap-3 px-5">
          <TextInput
            accessibilityLabel="Address"
            editable={!openingTab}
            value={emptyAddress}
            onChangeText={setEmptyAddress}
            onSubmitEditing={() => void openAddress()}
            placeholder="Enter a website address"
            placeholderTextColorClassName="accent-placeholder"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            selectTextOnFocus
            className="h-12 rounded-xl border border-input-border bg-input px-4 font-sans text-sm text-foreground"
          />
          <ControlPill
            icon="arrow.up.right"
            accessibilityLabel="Open address"
            label="Open"
            variant="primary"
            disabled={openingTab || emptyAddress.trim().length === 0}
            onPress={() => void openAddress()}
          />
          <AppText className="text-center text-sm text-foreground-muted">
            {openingTab
              ? "Opening page…"
              : loaded
                ? "Enter an address to open a browser tab."
                : "Connecting to the browser…"}
          </AppText>
          {!loaded && focused && foreground ? (
            <AppActivityIndicator color={themeVariables["--color-icon"]} />
          ) : null}
        </View>
      )}
    </View>
  );
}

function BrowserAddressBar({
  environmentId,
  tab,
  ready,
  streaming,
  onCommand,
  onPaste,
}: {
  readonly environmentId: EnvironmentId;
  readonly tab: PreviewSessionSnapshot;
  readonly ready: boolean;
  readonly streaming: boolean;
  readonly onCommand: PreviewStreamRef["command"];
  readonly onPaste: () => void;
}) {
  const url = browserTabUrl(tab);
  const [draft, setDraft] = useState<string | null>(null);
  const submit = () => {
    const value = draft ?? url;
    setDraft(null);
    try {
      onCommand({ type: "navigate", url: normalizePreviewUrl(value) });
    } catch {
      Dialog.alert("Could not open this address", "Enter an http or https URL.");
    }
  };
  return (
    <View className="flex-row items-center gap-1 px-2 pb-2">
      <ControlPill
        icon="chevron.left"
        accessibilityLabel="Back"
        disabled={!ready || !tab.canGoBack}
        onPress={() => onCommand({ type: "history", delta: -1 })}
      />
      <ControlPill
        icon="chevron.right"
        accessibilityLabel="Forward"
        disabled={!ready || !tab.canGoForward}
        onPress={() => onCommand({ type: "history", delta: 1 })}
      />
      <TextInput
        accessibilityLabel="Address"
        editable={ready}
        value={draft ?? url}
        onChangeText={setDraft}
        onBlur={() => setDraft(null)}
        onSubmitEditing={submit}
        placeholder="Enter a URL"
        placeholderTextColorClassName="accent-placeholder"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="go"
        selectTextOnFocus
        lineBreakModeIOS="tail"
        className="h-10 min-w-0 flex-1 rounded-full border border-input-border bg-input px-4 font-sans text-sm text-foreground"
      />
      <ControlPill
        icon="arrow.clockwise"
        accessibilityLabel="Reload page"
        disabled={!ready}
        onPress={() => onCommand({ type: "reload" })}
      />
      <BrowserTabMenu
        environmentId={environmentId}
        tab={tab}
        streaming={streaming}
        onPaste={ready ? onPaste : undefined}
      />
    </View>
  );
}
