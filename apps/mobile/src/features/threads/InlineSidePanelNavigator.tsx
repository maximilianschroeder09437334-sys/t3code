import {
  NavigationContainer,
  NavigationIndependentTree,
  type StaticScreenProps,
  useNavigation,
} from "@react-navigation/native";
import {
  createNativeStackNavigator,
  type NativeStackNavigationProp,
} from "@react-navigation/native-stack";
import type { ReactNode } from "react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { ThreadFileScreen } from "../files/ThreadFilesRouteScreen";
import { ThreadFileNavigatorPane } from "../files/thread-file-navigator-pane";
import { PullRequestRouteScreen } from "../pull-requests/PullRequestRouteScreen";
import type { PullRequestParams } from "../pull-requests/usePullRequestDiff";
import { ReviewSheet } from "../review/ReviewSheet";
import { useMobileNavigationTheme } from "../../lib/useMobileNavigationTheme";
import { GitBranchesSheet } from "./git/GitBranchesSheet";
import { GitCommitSheet } from "./git/GitCommitSheet";
import { GitConfirmSheet } from "./git/GitConfirmSheet";

type ThreadRef = { readonly environmentId: string; readonly threadId: string };
type GitConfirmParams = ThreadRef & {
  readonly confirmAction?: string;
  readonly branchName?: string;
  readonly includesCommit?: string;
  readonly commitMessage?: string;
  readonly filePaths?: string;
};
export type InlineRoutes = {
  Root: undefined;
  ThreadFile: ThreadRef & {
    readonly path: string[];
    readonly line?: string;
    readonly cwd?: string;
    readonly projectName?: string;
  };
  ThreadReview: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };
  GitCommit: ThreadRef;
  GitBranches: ThreadRef;
  GitConfirm: GitConfirmParams;
  PullRequest: PullRequestParams;
};

const Stack = createNativeStackNavigator<InlineRoutes>();

/** A thread's Files/Git/PR details stay in the inline surface's navigation history. */
export function InlineSidePanelNavigator(props: {
  readonly children: ReactNode;
  readonly identity: string;
}) {
  const theme = useMobileNavigationTheme();
  return (
    <NavigationIndependentTree>
      <NavigationContainer theme={theme} onUnhandledAction={() => {}}>
        <Stack.Navigator
          key={props.identity}
          initialRouteName="Root"
          screenOptions={{ headerShown: false, animation: "slide_from_right" }}
        >
          <Stack.Screen name="Root">{() => props.children}</Stack.Screen>
          <Stack.Screen name="ThreadFile" component={ThreadFileScreen} />
          <Stack.Screen name="ThreadReview" component={ReviewSheet} />
          <Stack.Screen name="GitCommit" component={GitCommitSheet} />
          <Stack.Screen name="GitBranches" component={GitBranchesSheet} />
          <Stack.Screen name="GitConfirm" component={GitConfirmSheet} />
          <Stack.Screen name="PullRequest" component={PullRequestRouteScreen} />
        </Stack.Navigator>
      </NavigationContainer>
    </NavigationIndependentTree>
  );
}

export type InlineSidePanelScreenProps<Name extends keyof InlineRoutes> = StaticScreenProps<
  InlineRoutes[Name]
>;

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
