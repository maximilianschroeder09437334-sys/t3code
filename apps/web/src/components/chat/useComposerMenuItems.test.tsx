import { EnvironmentId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ComposerCommandItem } from "./ComposerCommandMenu";
import { useComposerMenuItems } from "./useComposerMenuItems";

// The slash menu reads none of these; they are stubbed whole so the hook runs without a
// connected environment.
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => false }));
vi.mock("~/state/entities", () => ({ useVisibleThreadShells: () => [] }));
vi.mock("~/state/environments", () => ({
  useEnvironmentIdentities: () => [],
  useEnvironmentMachines: () => new Map(),
}));
vi.mock("~/state/peerLinks", () => ({ offersLinkedEnvironmentsAtom: () => "offers" }));
vi.mock("~/state/pullRequests", () => ({
  pullRequestEnvironment: { detail: () => null },
  usePullRequestList: () => ({ data: undefined, error: null, isPending: false }),
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({ data: undefined, error: null, isPending: false }),
}));
vi.mock("~/state/queries", () => ({
  useComposerPathSearch: () => ({ entries: [], searchedTarget: null, isPending: false }),
  useDebouncedValue: (value: unknown) => value,
  useThreadSearch: () => undefined,
}));

/** The slash menu's labels for what the user typed after `/`. */
function slashMenuLabels(query: string, threadNotesAvailable: boolean): string[] {
  let items: ReadonlyArray<ComposerCommandItem> = [];
  function Probe() {
    items = useComposerMenuItems({
      composerTrigger: {
        kind: "slash-command",
        query,
        rangeStart: 0,
        rangeEnd: query.length + 1,
      },
      environmentId: EnvironmentId.make("environment-test"),
      linkedEnvironments: new Map(),
      gitCwd: null,
      activeThreadId: threadNotesAvailable ? ThreadId.make("thread-test") : null,
      pullRequestProjectId: null,
      pullRequestRepository: null,
      threadPullRequests: undefined,
      sideChatAvailable: true,
      sideChatDisabledReason: null,
      freshSessionAvailable: true,
      threadNotesAvailable,
      compactSlashCommandAvailable: false,
      selectedProvider: ProviderDriverKind.make("codex"),
      selectedProviderSkills: [],
      selectedProviderSlashCommands: [],
      showSkillsInSlashMenu: false,
      workspaceSkillsScanning: false,
      questionAttachmentTarget: null,
      modelMentions: { instanceEntries: [], modelOptionsByInstance: new Map() },
    }).items;
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return items.map((item) => item.label);
}

describe("useComposerMenuItems /notes", () => {
  it("offers /notes only when the thread's notes can be read", () => {
    expect(slashMenuLabels("", true)).toContain("/notes");
    expect(slashMenuLabels("", false)).not.toContain("/notes");
    expect(slashMenuLabels("", false)).toEqual(expect.arrayContaining(["/hooks", "/model"]));
  });

  it("narrows to /notes as the command is typed", () => {
    expect(slashMenuLabels("no", true)).toEqual(["/notes"]);
    expect(slashMenuLabels("notes", true)).toEqual(["/notes"]);
    expect(slashMenuLabels("no", false)).toEqual([]);
  });
});
