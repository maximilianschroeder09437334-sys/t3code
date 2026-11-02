import { useRef, useState, type ComponentProps } from "react";
import {
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NewThreadButton } from "../../components/NewThreadButton";
import {
  androidHomeFabPosition,
  type AndroidHomeFabLayout as SharedAndroidHomeFabLayout,
} from "./AndroidHomeFab.shared";
import { useWorkspaceState } from "../../state/workspace";
import { FabScrollContext, FloatingUsageContext } from "./FabScrollContext";
import { SidebarUsage } from "../usage/SidebarUsage";
import { updateFabScroll } from "./fab-scroll";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { useEnabledNavigationTabs } from "../workspace/navigation-tabs";
import { WorkspaceTabsContext, useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { FLOATING_TABS, floatingTabsMetrics } from "../workspace/floating-workspace-tabs";
import {
  useAppearancePreferences,
  useAndroidFloatingTabs,
} from "../settings/appearance/AppearancePreferencesProvider";

export function AndroidHomeFabLayout(props: ComponentProps<typeof SharedAndroidHomeFabLayout>) {
  const floatingTabsEnabled = useAndroidFloatingTabs();
  const insets = useSafeAreaInsets();
  const { appearance } = useAppearancePreferences();
  const { fontScale } = useWindowDimensions();
  const [layoutWidth, setLayoutWidth] = useState<number | null>(null);
  const [usageHeight, setUsageHeight] = useState(0);
  const { state } = useWorkspaceState();
  const [expanded, setExpanded] = useState(true);
  const { scale, fabSize } = useAndroidControlSizing();
  const tabs = useEnabledNavigationTabs();
  const floating = floatingTabsMetrics(
    tabs.length + 1,
    scale,
    fabSize,
    props.paneWidth ?? layoutWidth ?? undefined,
  );
  const workspace = useWorkspaceTabs();
  const floatUsage = workspace !== null && (!props.sidebar || floatingTabsEnabled);
  const usageBottom = floatingTabsEnabled
    ? insets.bottom + FLOATING_TABS.bottom + floating.height + FLOATING_TABS.edge
    : insets.bottom + FLOATING_TABS.edge;
  const defaultFabPosition = androidHomeFabPosition(insets.bottom, props.sidebar);
  const fabBottom =
    floatUsage && usageHeight > 0
      ? usageBottom + usageHeight + FLOATING_TABS.gap
      : floatingTabsEnabled
        ? insets.bottom + FLOATING_TABS.bottom + floating.fabOffset
        : defaultFabPosition.bottom;
  const bottomClearance = Math.max(
    workspace?.bottomClearance ?? 0,
    fabBottom + fabSize + FLOATING_TABS.edge,
  );
  const context = workspace && floatUsage ? { ...workspace, bottomClearance } : workspace;
  const scrollState = useRef({ anchor: 0, expanded: true });
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const next = updateFabScroll(
      scrollState.current,
      contentOffset.y,
      contentSize.height - layoutMeasurement.height,
    );
    if (next.expanded !== scrollState.current.expanded) setExpanded(next.expanded);
    scrollState.current = next;
  };

  // Remount only the FAB when its font or pane changes to clear the cached expanded width.
  // Floating navigation shares this row; Material split views put New thread in the rail.
  return (
    <View className="flex-1" onLayout={(event) => setLayoutWidth(event.nativeEvent.layout.width)}>
      <WorkspaceTabsContext value={context}>
        <FloatingUsageContext value={floatUsage}>
          <FabScrollContext value={onScroll}>{props.children}</FabScrollContext>
          {floatUsage ? (
            <View
              className="bg-screen"
              onLayout={(event) => setUsageHeight(event.nativeEvent.layout.height)}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: usageBottom,
              }}
            >
              <SidebarUsage />
            </View>
          ) : null}
        </FloatingUsageContext>
      </WorkspaceTabsContext>
      {!props.disabled &&
      (!props.sidebar || floatingTabsEnabled) &&
      state.hasConnections &&
      layoutWidth !== null ? (
        <NewThreadButton
          key={`${appearance.baseFontSize}:${fontScale}:${layoutWidth}`}
          extended
          expanded={floatingTabsEnabled ? false : expanded}
          onPress={props.onStartNewTask}
          className="absolute"
          style={
            floatingTabsEnabled
              ? {
                  right: FLOATING_TABS.edge,
                  bottom: fabBottom,
                }
              : { ...defaultFabPosition, bottom: fabBottom }
          }
        />
      ) : null}
    </View>
  );
}
