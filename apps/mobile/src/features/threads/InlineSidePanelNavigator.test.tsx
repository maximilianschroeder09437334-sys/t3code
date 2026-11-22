import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { useNavigation, useRoute, StackActions } from "@react-navigation/native";

vi.mock("@react-navigation/native", async () => {
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const localRequire = createRequire(import.meta.url);
  const navigationRequire = createRequire(localRequire.resolve("@react-navigation/native"));
  const core = await import(
    /* @vite-ignore */ pathToFileURL(navigationRequire.resolve("@react-navigation/core")).href
  );
  const routers = await import(
    /* @vite-ignore */ pathToFileURL(navigationRequire.resolve("@react-navigation/routers")).href
  );
  return { ...core, ...routers, NavigationContainer: core.BaseNavigationContainer };
});
vi.mock("react-native", () => ({
  View: ({ children, testID }: { children: ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
}));
vi.mock("../../lib/useMobileNavigationTheme", () => ({
  useMobileNavigationTheme: () => undefined,
}));
vi.mock("../../components/ui/ScreenContent", () => ({
  ScreenContent: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock("./ThreadDetailScreen", () => ({ ThreadDetailScreen: () => <div>parent body</div> }));
vi.mock("../files/thread-file-navigator-pane", () => ({ ThreadFileNavigatorPane: () => null }));
// Only the native presentation is replaced. Real navigation builder, router,
// route contexts and independent-tree forwarding run below.
vi.mock("@react-navigation/native-stack", async () => {
  const { createNavigatorFactory, useNavigationBuilder, StackRouter } =
    await import("@react-navigation/native");
  function Navigator(props: Parameters<typeof useNavigationBuilder>[1]) {
    const { state, descriptors, NavigationContent } = useNavigationBuilder(StackRouter, props);
    return (
      <NavigationContent>
        {state.routes.map((route, index) => (
          <div key={route.key} hidden={index !== state.index}>
            {descriptors[route.key]!.render()}
          </div>
        ))}
      </NavigationContent>
    );
  }
  return { createNativeStackNavigator: createNavigatorFactory(Navigator) };
});
vi.mock("../../Stack", () => ({
  mobileRouteScreens: () =>
    Object.fromEntries(
      [
        "ThreadQueue",
        "ThreadAgents",
        "ThreadBackgroundWork",
        "ThreadBrowserPreview",
        "ThreadDevicePreview",
        "Connections",
        "GitCommit",
        "GitBranches",
        "GitConfirm",
        "PullRequest",
      ].map((name) => [name, { screen: Destination }]),
    ),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({}) }));
vi.mock("../../state/entities", () => ({
  useQuietThreadShell: (ref: { environmentId: string; threadId: string } | null) =>
    ref ? { ...ref, id: ref.threadId, projectId: "repo" } : null,
  useProject: (ref: object) => ref,
}));
vi.mock("../../state/threads", () => ({
  useEnvironmentThread: () => ({ data: { _tag: "None" } }),
}));
vi.mock("../../state/pending-thread-creation", () => ({
  pendingThreadCreationOutcomesAtom: {},
  selectThreadCreationDetail: ({ threadRef }: { threadRef: object }) => ({
    pendingCreation: null,
    detailRef: threadRef,
  }),
  resolvePendingThreadCreation: () => null,
}));
vi.mock("../../state/use-thread-outbox", () => ({ useThreadOutboxMessages: () => ({}) }));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnection: (id: string) => ({ environmentId: id }),
  useRemoteEnvironmentRuntime: (id: string) => ({ environmentId: id, readOnly: true }),
}));
vi.mock("@legendapp/list/react-native", () => ({
  LegendList: (props: {
    data: object[];
    renderItem: (input: { item: object; index: number }) => ReactNode;
  }) =>
    props.data.map((item, index) => (
      <div key={JSON.stringify(item)}>{props.renderItem({ item, index })}</div>
    )),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/SheetHeader", () => ({ SheetHeader: () => null }));
vi.mock("./LinkedPullRequestList", () => ({
  useLinkedPullRequestLines: () => [{ link: { snapshot: { state: "open" } } }],
  linkedPullRequestKey: () => "pr",
  LinkedPullRequestRow: ({ openPullRequest }: { openPullRequest: (url: string) => void }) => (
    <button onClick={() => openPullRequest("https://example.com/pr/1")}>linked PR</button>
  ),
}));
vi.mock("./useLinkedPullRequestActions", () => ({
  useLinkedPullRequestActions: () => ({
    terminology: { singular: "pull request", plural: "pull requests" },
  }),
}));
// Replace remote PR URL resolution only; exercise the actual list's push/replace decision.
vi.mock("../../native/useOpenPullRequest", () => ({
  useOpenPullRequest: (options: { replace?: boolean }) => {
    const navigation = useNavigation();
    return () =>
      navigation.dispatch(
        (options.replace ? StackActions.replace : StackActions.push)("PullRequest", { number: 1 }),
      );
  },
}));
import { ThreadPullRequestsSheet } from "./ThreadPullRequestsSheet";
import { useThreadSelection } from "../../state/use-thread-selection";
import { InlineSidePanelNavigator } from "./InlineSidePanelNavigator";
import { ThreadPreviewRoute } from "./thread-preview-route";
import { ThreadScreenHost, ThreadScreenFallback, ThreadScreenOverlay } from "./ThreadScreenHost";

function Destination() {
  const route = useRoute();
  const navigation = useNavigation();
  return (
    <section>
      <output>{JSON.stringify({ name: route.name, params: route.params })}</output>
      <button onClick={() => navigation.goBack()}>back</button>
    </section>
  );
}
function Scope({ child = false }: { child?: boolean }) {
  const selected = useThreadSelection();
  const navigation = useNavigation();
  return (
    <article>
      <output>
        {JSON.stringify({
          ref: selected.selectedThreadRef,
          project: selected.selectedThreadProject,
          runtime: selected.selectedEnvironmentRuntime,
        })}
      </output>
      {(child
        ? [
            "ThreadQueue",
            "ThreadAgents",
            "ThreadBackgroundWork",
            "ThreadBrowserPreview",
            "ThreadDevicePreview",
            "Connections",
          ]
        : ["GitCommit", "GitBranches", "GitConfirm", "PullRequest"]
      ).map((name) => (
        <button
          key={name}
          onClick={() =>
            navigation.dispatch(
              StackActions.push(name, {
                environmentId: selected.selectedThreadRef!.environmentId,
                threadId: selected.selectedThreadRef!.threadId,
              }),
            )
          }
        >
          {name}
        </button>
      ))}
    </article>
  );
}
function mount(children: ReactNode) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  act(() => root.render(children));
  return {
    container,
    close: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}
function press(container: HTMLElement, text: string) {
  const button = [...container.querySelectorAll("button")].find(
    (el) => el.textContent === text && !el.closest("[hidden]"),
  );
  expect(button).toBeTruthy();
  act(() => button!.click());
}
function pane(children: ReactNode) {
  return (
    <InlineSidePanelNavigator
      identity="remote:parent:surface"
      environmentId="remote"
      threadId="parent"
    >
      {children}
    </InlineSidePanelNavigator>
  );
}

it("resolves real root selection and read-only remote context through detail pushes and return", () => {
  const screen = mount(pane(<Scope />));
  try {
    for (const name of ["GitCommit", "GitBranches", "GitConfirm", "PullRequest"]) {
      const before = screen.container.querySelector("article output")!.textContent!;
      expect(JSON.parse(before)).toEqual({
        ref: { environmentId: "remote", threadId: "parent" },
        project: { environmentId: "remote", projectId: "repo" },
        runtime: { environmentId: "remote", readOnly: true },
      });
      press(screen.container, name);
      expect(JSON.parse(screen.container.querySelector("section output")!.textContent!)).toEqual({
        name,
        params: { environmentId: "remote", threadId: "parent" },
      });
      press(screen.container, "back");
      expect(screen.container.querySelector("section")).toBeNull();
      expect(screen.container.querySelector("article output")!.textContent).toBe(before);
    }
  } finally {
    screen.close();
  }
});
it("forwards child destinations into the pane with child scope and returns without changing parent", () => {
  const screen = mount(
    pane(
      <>
        <Scope />
        <ThreadPreviewRoute environmentId="linked-remote" threadId="child">
          {() => <Scope child />}
        </ThreadPreviewRoute>
      </>,
    ),
  );
  try {
    for (const name of [
      "ThreadQueue",
      "ThreadAgents",
      "ThreadBackgroundWork",
      "ThreadBrowserPreview",
      "ThreadDevicePreview",
      "Connections",
    ]) {
      press(screen.container, name);
      expect(JSON.parse(screen.container.querySelector("section output")!.textContent!)).toEqual({
        name,
        params: { environmentId: "linked-remote", threadId: "child" },
      });
      press(screen.container, "back");
      expect(screen.container.querySelectorAll("article")).toHaveLength(2);
      expect(screen.container.querySelector("article output")!.textContent).toContain(
        '"threadId":"parent"',
      );
      expect(screen.container.querySelectorAll("article output")[1]!.textContent).toContain(
        '"threadId":"child"',
      );
    }
  } finally {
    screen.close();
  }
});
it("hosts overlay within actual host content bounds after the header while retaining parent body", () => {
  const screen = mount(
    <ThreadScreenHost>
      <ThreadScreenFallback
        header={
          <header>
            <button>parent action</button>
            <ThreadScreenOverlay>
              <aside>tabs and pane</aside>
            </ThreadScreenOverlay>
          </header>
        }
      >
        <input defaultValue="parent draft" />
      </ThreadScreenFallback>
    </ThreadScreenHost>,
  );
  try {
    const header = screen.container.querySelector("header")!;
    const body = screen.container.querySelector('[data-testid="thread-content-area"]')!;
    expect(header.nextElementSibling).toBe(body);
    expect(body.querySelector('[data-testid="thread-content-overlay"] aside')!.textContent).toBe(
      "tabs and pane",
    );
    expect(header.contains(screen.container.querySelector("aside"))).toBe(false);
    expect(screen.container.querySelector("input")!.value).toBe("parent draft");
    press(screen.container, "parent action");
  } finally {
    screen.close();
  }
});

it("opens from actual inline linked PR list and returns to that list", () => {
  const screen = mount(
    pane(
      <ThreadPullRequestsSheet
        route={{ params: { environmentId: "remote", threadId: "parent" } }}
        onCloseInline={() => {}}
      />,
    ),
  );
  try {
    press(screen.container, "linked PR");
    expect(screen.container.querySelector("section")).toBeTruthy();
    press(screen.container, "back");
    expect(screen.container.querySelector("section")).toBeNull();
    expect(screen.container.textContent).toContain("linked PR");
  } finally {
    screen.close();
  }
});
