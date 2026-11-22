import {
  NavigationContainer,
  NavigationIndependentTree,
  type StaticParamList,
  useNavigation,
} from "@react-navigation/native";
import {
  createNativeStackNavigator,
  type NativeStackNavigationProp,
} from "@react-navigation/native-stack";
import type { ComponentType, ReactNode } from "react";
import type { EnvironmentId } from "@t3tools/contracts";

import { mobileRouteScreens, type RootStack } from "../../Stack";
import { ThreadFileNavigatorPane } from "../files/thread-file-navigator-pane";
import { useMobileNavigationTheme } from "../../lib/useMobileNavigationTheme";

type ThreadRef = { readonly environmentId: string; readonly threadId: string };
type InlineRoutes = StaticParamList<typeof RootStack> & { Root: ThreadRef };

const Stack = createNativeStackNavigator<InlineRoutes>();

/** A thread's Files/Git/PR details stay in the inline surface's navigation history. */
export function InlineSidePanelNavigator(props: {
  readonly children: ReactNode;
  readonly identity: string;
  readonly environmentId: string;
  readonly threadId: string;
}) {
  const theme = useMobileNavigationTheme();
  return (
    <NavigationIndependentTree>
      <NavigationContainer theme={theme}>
        <Stack.Navigator
          key={props.identity}
          initialRouteName="Root"
          screenOptions={{ headerShown: false, animation: "slide_from_right" }}
        >
          <Stack.Screen
            name="Root"
            initialParams={{ environmentId: props.environmentId, threadId: props.threadId }}
          >
            {() => props.children}
          </Stack.Screen>
          {Object.entries(mobileRouteScreens()).map(([name, config]) => (
            <Stack.Screen
              key={name}
              name={name as keyof InlineRoutes}
              component={config.screen as ComponentType<object>}
            />
          ))}
        </Stack.Navigator>
      </NavigationContainer>
    </NavigationIndependentTree>
  );
}

export function InlineThreadFilesPane(props: {
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly projectName: string;
}) {
  const navigation = useNavigation<NativeStackNavigationProp<InlineRoutes>>();
  return (
    <ThreadFileNavigatorPane
      cwd={props.cwd}
      environmentId={props.environmentId}
      projectName={props.projectName}
      selectedPath={null}
      onSelectFile={(path) =>
        navigation.navigate("ThreadFile", {
          environmentId: props.environmentId,
          threadId: props.threadId,
          path: path.split("/").filter(Boolean),
        })
      }
    />
  );
}
