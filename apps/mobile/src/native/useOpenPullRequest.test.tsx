import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  external: vi.fn(async () => true),
  alert: vi.fn(),
  preview: vi.fn(async () => ({ _tag: "Success", value: { tabId: "tab-1" } })),
  destination: vi.fn(() => null),
  allowed: true,
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mocks.navigate, dispatch: vi.fn() }),
  useRoute: () => ({ params: { environmentId: "pc", projectId: "project", threadId: "thread" } }),
  StackActions: { push: vi.fn(), replace: vi.fn() },
}));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("../lib/pullRequestNavigation", () => ({
  nativePullRequestDestination: mocks.destination,
}));
vi.mock("../features/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => vi.fn(),
}));
vi.mock("../state/entities", () => ({ useProjects: () => [], useThreadShell: () => null }));
vi.mock("../lib/openExternalUrl", () => ({ tryOpenExternalUrl: mocks.external }));
vi.mock("../components/ui/Dialog", () => ({ alert: mocks.alert }));
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: "configs" }));
vi.mock("../state/preview", () => ({
  previewEnvironment: { open: { permissionAtom: () => "permission" } },
}));
vi.mock("../state/atom-registry", () => ({
  appAtomRegistry: {
    get: (key: string) =>
      key === "configs"
        ? new Map([["pc", { environment: { capabilities: { serverBrowser: true } } }]])
        : mocks.allowed,
  },
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => mocks.preview }));
import { useOpenPullRequest } from "./useOpenPullRequest";

it("opens thread web links in the server browser and reports unavailable access without opening an external browser", async () => {
  mocks.allowed = true;
  mocks.navigate.mockClear();
  mocks.external.mockClear();
  mocks.alert.mockClear();
  mocks.preview.mockClear();
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  function Probe() {
    const open = useOpenPullRequest();
    return <button onClick={() => void open("https://example.com/")}>Open</button>;
  }
  await act(async () => root.render(<Probe />));
  await act(async () => {
    node.querySelector("button")!.click();
  });
  expect(mocks.preview).toHaveBeenCalledWith({
    environmentId: "pc",
    input: { threadId: "thread", url: "https://example.com/", runtime: "server" },
  });
  expect(mocks.navigate).toHaveBeenCalledWith("ThreadBrowserPreview", {
    environmentId: "pc",
    threadId: "thread",
    tabId: "tab-1",
  });
  expect(mocks.external).not.toHaveBeenCalled();
  mocks.allowed = false;
  await act(async () => {
    node.querySelector("button")!.click();
  });
  expect(mocks.alert).toHaveBeenCalled();
  expect(mocks.external).not.toHaveBeenCalled();
  await act(async () => root.unmount());
  node.remove();
});
