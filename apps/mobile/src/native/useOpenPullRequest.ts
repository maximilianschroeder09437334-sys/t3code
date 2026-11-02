import * as Dialog from "../components/ui/Dialog";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { previewEnvironment } from "../state/preview";
import { useAtomCommand } from "../state/use-atom-command";
import { useNavigation, useRoute, StackActions } from "@react-navigation/native";
import { nativePullRequestDestination } from "../lib/pullRequestNavigation";
import { Platform } from "react-native";
import { useSelectWorkspaceDetail } from "../features/workspace/useSelectWorkspaceDetail";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useProjects, useThreadShell } from "../state/entities";
import { tryOpenExternalUrl } from "../lib/openExternalUrl";
import { appAtomRegistry } from "../state/atom-registry";
import { environmentServerConfigsAtom } from "../state/server";

type PullRequestContext = { readonly environmentId: string; readonly projectId: string };

// Avoid useRoute so layouts without route context can open any thread's pull requests.
export function useNavigateToPullRequest(options?: {
  readonly replace?: boolean;
  readonly fallback?: (url: string) => Promise<boolean>;
}) {
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  const projects = useProjects();
  const replace = options?.replace;
  return async (url: string, context: PullRequestContext | null) => {
    // Read at press time so a config push does not hand every link a new handler.
    const serverConfigs = appAtomRegistry.get(environmentServerConfigsAtom);
    const params = nativePullRequestDestination(url, context, projects, (environmentId) =>
      serverConfigs.has(environmentId),
    );
    if (!params)
      return options?.fallback ? options.fallback(url) : tryOpenExternalUrl(url, "pull-request");
    // Android shows one page at a time; iOS opens it over the current page, so Back returns.
    if (Platform.OS === "android") selectDetail({ name: "PullRequest", params });
    else if (replace) navigation.dispatch(StackActions.replace("PullRequest", params));
    else navigation.dispatch(StackActions.push("PullRequest", params));
    return true;
  };
}

export function useOpenPullRequest(options?: {
  readonly replace?: boolean;
  readonly context?: PullRequestContext;
}) {
  const route = useRoute();
  const routeContext = route.params as
    | {
        environmentId?: string | string[];
        projectId?: string | string[];
        threadId?: string | string[];
      }
    | undefined;
  const first = (value: string | string[] | undefined) => {
    const text = Array.isArray(value) ? value[0] : value;
    return text?.trim() ? text : undefined;
  };
  const environmentId = options?.context?.environmentId ?? first(routeContext?.environmentId);
  const threadId = first(routeContext?.threadId);
  const thread = useThreadShell(
    environmentId && threadId
      ? { environmentId: EnvironmentId.make(environmentId), threadId: ThreadId.make(threadId) }
      : null,
  );
  const projectId =
    options?.context?.projectId ?? first(routeContext?.projectId) ?? thread?.projectId;
  const navigation = useNavigation();
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const navigateToPullRequest = useNavigateToPullRequest({
    replace: options?.replace,
    fallback: async (url) => {
      if (!environmentId || !threadId || !/^https?:\/\//i.test(url))
        return tryOpenExternalUrl(url, "pull-request");
      const targetEnvironment = EnvironmentId.make(environmentId);
      const config = appAtomRegistry.get(environmentServerConfigsAtom).get(targetEnvironment);
      if (
        config?.environment.capabilities.serverBrowser !== true ||
        !appAtomRegistry.get(previewEnvironment.open.permissionAtom(targetEnvironment))
      ) {
        Dialog.alert(
          "Browser unavailable",
          "Connect to an environment with browser access and try again.",
        );
        return false;
      }
      const result = await openPreview({
        environmentId: targetEnvironment,
        input: { threadId: ThreadId.make(threadId), url, runtime: "server" },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result))
          Dialog.alert("Could not open the browser", "Check the connection and try again.");
        return false;
      }
      navigation.navigate("ThreadBrowserPreview", {
        environmentId,
        threadId,
        tabId: result.value.tabId,
      });
      return true;
    },
  });
  return (url: string) =>
    navigateToPullRequest(
      url,
      environmentId && projectId
        ? { environmentId: String(environmentId), projectId: String(projectId) }
        : null,
    );
}
