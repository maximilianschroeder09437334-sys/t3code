import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { projectKey, threadKey } from "@t3tools/client-runtime/state/entities";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { ProviderDriverKind } from "@t3tools/contracts";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import {
  CheckIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  CircleStopIcon,
  Clock3Icon,
  FolderIcon,
  FolderPlusIcon,
  HomeIcon,
  LoaderCircleIcon,
  SearchIcon,
} from "lucide-react";
import {
  LAST_USED_PROJECT_STORAGE_KEY,
  readLastUsedProjectKey,
  resolveDefaultProjectRef,
  useNewThreadHandler,
  type NewThreadHandler,
} from "../../hooks/useHandleNewThread";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useNowMinute } from "../../hooks/useNowMinute";
import { sortScopedProjectsForSidebar, resolveSidebarThreadStatus } from "../Sidebar.logic";
import { useProjects, useVisibleThreadShells } from "../../state/entities";
import { openCommandPalette } from "../../commandPaletteBus";
import { useUiStateStore } from "../../uiStateStore";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import { ProjectFavicon } from "../ProjectFavicon";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { useEnvironmentProviders } from "../../state/environments";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { HomeSnoozeMenu } from "./HomeSnoozeMenu";
import {
  countHomeRows,
  deriveHomeRows,
  formatHomeTimeLabel,
  homeComposerProjectRef,
  homeCountSegments,
  homeDurationMinutes,
  homeThreadWasStopped,
  homeThreadRef,
  type HomeRow,
  type HomeSection,
} from "./Home.logic";
import ChatView from "../ChatView";

const labels: Record<HomeSection, string> = {
  needs: "Needs you",
  done: "Done since you looked",
  running: "Running",
};
const sectionColors: Record<HomeSection, string> = {
  needs: "text-warning-foreground",
  done: "text-success",
  running: "text-info-foreground",
};
const projectKeyStorage = LAST_USED_PROJECT_STORAGE_KEY;

function persistProjectKey(key: string | null) {
  try {
    if (key) localStorage.setItem(projectKeyStorage, key);
    else localStorage.removeItem(projectKeyStorage);
  } catch {
    /* Browser storage may be disabled. */
  }
}

export function HomeView() {
  const projects = useProjects();
  const threads = useVisibleThreadShells();
  const providersByEnvironment = useEnvironmentProviders();
  const now = useNowMinute();
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const rows = deriveHomeRows({ threads, projects, now, lastVisitedAt: null });
  const counts = countHomeRows(rows);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [questionTextByThread, setQuestionTextByThread] = useState<Record<string, string>>({});
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({});
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(
    readLastUsedProjectKey,
  );
  const [composerProjectKey, setComposerProjectKey] = useState<string | null>(
    readLastUsedProjectKey,
  );
  const router = useRouter();
  const { settleThread } = useThreadActions();
  const activeProjects = projects.filter((project) => project.archivedAt == null);
  const orderedProjects = sortScopedProjectsForSidebar(activeProjects, threads, "updated_at");
  useEffect(() => {
    if (activeProjects.length === 0) return;
    if (selectedProjectKey && activeProjects.some((project) => projectKeyOf(project) === selectedProjectKey))
      return;
    const defaultRef = resolveDefaultProjectRef(
      activeProjects,
      projectOrder,
      readLastUsedProjectKey(),
    );
    if (!defaultRef) return;
    const nextKey = projectKey(scopeProjectRef(defaultRef.environmentId, defaultRef.projectId));
    setSelectedProjectKey(nextKey);
    setComposerProjectKey(nextKey);
    persistProjectKey(nextKey);
  }, [activeProjects, projectOrder, selectedProjectKey]);

  const onQuestionText = useCallback((key: string, text: string) => {
    setQuestionTextByThread((current) =>
      current[key] === text ? current : { ...current, [key]: text },
    );
  }, []);

  const search = query.trim().toLocaleLowerCase();
  const candidates = rows.filter((row) => filter === "all" || row.projectKey === filter);
  const visible = candidates.filter((row) => {
    if (!search) return true;
    const key = threadKey({ environmentId: row.thread.environmentId, threadId: row.thread.id });
    const haystack = [row.thread.title, row.projectName, questionTextByThread[key] ?? ""]
      .join(" ")
      .toLocaleLowerCase();
    return haystack.includes(search);
  });
  const sectionRows = (section: HomeSection) => visible.filter((row) => row.section === section);
  const requestedItem = (router.state.location.search as { item?: unknown }).item;
  const deepLinkedItem = typeof requestedItem === "string" ? requestedItem : null;

  useEffect(() => {
    if (!deepLinkedItem) return;
    setExpandedItems((current) => ({ ...current, [deepLinkedItem]: true }));
    document
      .querySelector<HTMLElement>(`[data-home-item="${encodeURIComponent(deepLinkedItem)}"]`)
      ?.scrollIntoView({ block: "center" });
  }, [deepLinkedItem]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "/" ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        /INPUT|TEXTAREA/.test(document.activeElement?.tagName ?? "")
      )
        return;
      event.preventDefault();
      document.querySelector<HTMLInputElement>('[aria-label="Search Home"]')?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const chooseProject = (key: string | null) => {
    setSelectedProjectKey(key);
    if (key !== null) setComposerProjectKey(key);
    persistProjectKey(key);
  };
  const activeComposerProjectKey = selectedProjectKey ?? composerProjectKey;
  const composerProjectRef = homeComposerProjectRef(activeProjects, activeComposerProjectKey);
  const composerProject = composerProjectRef
    ? activeProjects.find(
        (project) =>
          project.environmentId === composerProjectRef.environmentId &&
          project.id === composerProjectRef.projectId,
      )
    : null;

  return (
    <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {search ? (
        <div className="sr-only" aria-live="polite">
          {visible.length} Home results
        </div>
      ) : null}
      {search
        ? rows
            .filter((row) => row.section === "needs")
            .map((row) => (
              <HomeQuestionIndex
                key={threadKey({ environmentId: row.thread.environmentId, threadId: row.thread.id })}
                row={row}
                onText={onQuestionText}
              />
            ))
        : null}
      <header className="shrink-0 px-6 pt-8">
        <div className="mx-auto w-full max-w-3xl">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Home</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                <HomeCountSummary counts={counts} doneLabel="done since you looked" />
              </p>
            </div>
            <label className="flex h-9 w-full max-w-60 items-center gap-2 rounded-lg border border-border/70 bg-background px-3 text-sm text-muted-foreground sm:w-60">
              <SearchIcon className="size-4 shrink-0" aria-hidden="true" />
              <input
                aria-label="Search Home"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search Home"
                className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
              />
              <kbd className="rounded border px-1 text-2xs">/</kbd>
            </label>
          </div>
          <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Filter by project">
            <Button
              size="sm"
              variant={filter === "all" ? "secondary" : "outline"}
              aria-pressed={filter === "all"}
              onClick={() => setFilter("all")}
            >
              All <span className="ml-1 text-muted-foreground">{rows.length}</span>
            </Button>
            {orderedProjects
              .filter((project) => rows.some((row) => row.projectKey === projectKeyOf(project)))
              .map((project) => {
                const key = projectKeyOf(project);
                return (
                  <Button
                    key={key}
                    size="sm"
                    variant={filter === key ? "secondary" : "outline"}
                    aria-pressed={filter === key}
                    onClick={() => setFilter(key)}
                  >
                    <ProjectFavicon project={project} className="size-3.5" />
                    {project.title}
                    <span className="ml-1 text-muted-foreground">
                      {rows.filter((row) => row.projectKey === key).length}
                    </span>
                  </Button>
                );
              })}
            {rows.some((row) => !activeProjects.some((project) => projectKeyOf(project) === row.projectKey)) ? (
              <Button
                size="sm"
                variant={filter === "none" ? "secondary" : "outline"}
                aria-pressed={filter === "none"}
                onClick={() => setFilter("none")}
              >
                <FolderIcon className="size-3.5" /> No project
                <span className="ml-1 text-muted-foreground">
                  {rows.filter((row) => !activeProjects.some((project) => projectKeyOf(project) === row.projectKey)).length}
                </span>
              </Button>
            ) : null}
          </div>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-44 pt-6 scrollbar-gutter-both">
        <div className="mx-auto w-full max-w-3xl space-y-7">
          {(["needs", "done", "running"] as const).map((section) => {
            const items = sectionRows(section);
            const projectGroups = orderedProjects
              .map((project) => ({
                project,
                rows: items.filter((row) => row.projectKey === projectKeyOf(project)),
              }))
              .filter((group) => group.rows.length > 0);
            const unknownRows = items.filter(
              (row) => !activeProjects.some((project) => projectKeyOf(project) === row.projectKey),
            );
            if (unknownRows.length > 0) {
              projectGroups.push({ project: null as never, rows: unknownRows });
            }
            return (
              <section key={section} aria-labelledby={`home-${section}`}>
                <h2
                  id={`home-${section}`}
                  className={`mb-2 flex items-center gap-2 text-sm font-semibold ${sectionColors[section]}`}
                >
                  {labels[section]}
                  <span
                    className={`rounded-full bg-muted px-2 py-0.5 text-xs ${sectionColors[section]}`}
                  >
                    {items.length}
                  </span>
                </h2>
                {items.length === 0 ? (
                  <p className="py-2 text-sm text-muted-foreground">
                    {section === "needs" ? "Nothing needs you right now." : "Nothing here."}
                  </p>
                ) : (
                  <div className="space-y-3">
                    {projectGroups.map((group) => {
                      const project = group.project as EnvironmentProject | null;
                      const age = Math.max(...group.rows.map((row) => homeDurationMinutes(row.thread, now)));
                      const timing =
                        group.rows.length >= 2 && (section === "needs" || section === "running")
                          ? `${section === "needs" ? "oldest waiting" : "longest running"} ${durationLabel(age)}`
                          : null;
                      const groupKey = project ? projectKeyOf(project) : "none";
                      return (
                        <div key={groupKey}>
                          <div className="mb-1 flex min-h-6 items-center gap-1.5 px-0.5 text-xs text-muted-foreground">
                            {project ? (
                              <ProjectFavicon project={project} className="size-4 shrink-0" />
                            ) : (
                              <FolderIcon className="size-4 shrink-0" />
                            )}
                            <span>{project?.title ?? "No project"}</span>
                            <span className={sectionColors[section]}>{group.rows.length}</span>
                            {timing ? <span className="ml-auto tabular-nums">{timing}</span> : null}
                          </div>
                          <div className="space-y-2">
                            {group.rows.map((row) => {
                              const key = threadKey({
                                environmentId: row.thread.environmentId,
                                threadId: row.thread.id,
                              });
                              const provider = providersByEnvironment
                                .get(row.thread.environmentId)
                                ?.find((entry) => entry.instanceId === row.thread.providerInstanceId);
                              const status = resolveSidebarThreadStatus(row.thread);
                              const timeColor =
                                status === "failed"
                                  ? "text-error-foreground"
                                  : row.section === "needs"
                                    ? "text-warning-foreground"
                                    : row.section === "done"
                                      ? "text-success"
                                      : "text-info-foreground";
                              const openThread = () =>
                                void router.navigate({
                                  to: "/$environmentId/$threadId",
                                  params: {
                                    environmentId: row.thread.environmentId,
                                    threadId: row.thread.id,
                                  },
                                });
                              return (
                                <article
                                  key={key}
                                  data-home-item={encodeURIComponent(key)}
                                  className="rounded-xl border border-border/70 px-3 py-2.5 hover:bg-muted/30"
                                >
                                  <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                                    <ProviderInstanceIcon
                                      driverKind={provider?.driver ?? ProviderDriverKind.make("codex")}
                                      displayName={provider?.displayName ?? String(row.thread.providerInstanceId)}
                                      size="compact"
                                    />
                                    <span className="min-w-0 flex-1 truncate">
                                      {row.thread.title || "New thread"}
                                    </span>
                                    <span className={`flex shrink-0 items-center gap-1.5 tabular-nums ${timeColor}`}>
                                      {homeThreadWasStopped(row.thread) ? (
                                        <CircleStopIcon className="size-3.5" aria-hidden="true" />
                                      ) : status === "failed" ? (
                                        <CircleStopIcon className="size-3.5" aria-hidden="true" />
                                      ) : row.section === "needs" ? (
                                        <Clock3Icon className="size-3.5" aria-hidden="true" />
                                      ) : row.section === "done" ? (
                                        <CircleCheckIcon className="size-3.5" aria-hidden="true" />
                                      ) : (
                                        <LoaderCircleIcon className="size-3.5" aria-hidden="true" />
                                      )}
                                      {formatHomeTimeLabel(row.thread, now)}
                                    </span>
                                  </div>
                                  {row.section === "needs" ? (
                                    <HomeNeedsPanel
                                      thread={row.thread}
                                      onOpen={openThread}
                                      expanded={expandedItems[key] === true || deepLinkedItem === key}
                                      onExpandedChange={(open) =>
                                        setExpandedItems((current) => ({ ...current, [key]: open }))
                                      }
                                    />
                                  ) : (
                                    <div className="mt-1 flex items-center gap-3">
                                      <div className="min-w-0 flex-1 truncate text-sm font-medium">
                                        {row.thread.latestRun?.providerStartingLabel ?? row.thread.title ?? "New thread"}
                                      </div>
                                      <div className="flex shrink-0 items-center gap-1">
                                        <Button size="xs" variant="ghost" onClick={openThread}>
                                          Open
                                        </Button>
                                        {row.section === "done" ? (
                                          <>
                                            <Button
                                              size="xs"
                                              variant="ghost"
                                              onClick={() => void settleThread(homeThreadRef(row.thread))}
                                            >
                                              <CheckIcon /> Settle
                                            </Button>
                                            <HomeSnoozeMenu threadRef={homeThreadRef(row.thread)} />
                                          </>
                                        ) : null}
                                      </div>
                                    </div>
                                  )}
                                  {row.predecessors.length > 0 ? (
                                    <details className="mt-2 text-xs text-muted-foreground">
                                      <summary className="inline-flex cursor-pointer items-center gap-1">
                                        <ChevronDownIcon className="size-3" />
                                        {row.predecessors.length + 1} threads
                                      </summary>
                                      {row.predecessors.map((previous) => (
                                        <button
                                          key={previous.id}
                                          className="block py-1 pl-4 text-left hover:text-foreground"
                                          onClick={() =>
                                            void router.navigate({
                                              to: "/$environmentId/$threadId",
                                              params: {
                                                environmentId: previous.environmentId,
                                                threadId: previous.id,
                                              },
                                            })
                                          }
                                        >
                                          {previous.title} · settled by successor
                                        </button>
                                      ))}
                                    </details>
                                  ) : null}
                                </article>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>
      <div className="pointer-events-none absolute inset-0 z-30">
        {composerProject && composerProjectRef ? (
          <HomeThreadComposer
            key={`${composerProject.environmentId}:${composerProject.id}`}
            project={composerProject}
            canSend={selectedProjectKey !== null}
            projectControl={
              <HomeProjectPicker
                projects={orderedProjects}
                selectedProjectKey={selectedProjectKey}
                onSelect={chooseProject}
              />
            }
          />
        ) : null}
      </div>
    </main>
  );
}

function HomeCountSummary({
  counts,
  doneLabel,
}: {
  counts: ReturnType<typeof countHomeRows>;
  doneLabel: string;
}) {
  return (
    <>
      {homeCountSegments(counts, { done: doneLabel }).map((segment, index) => (
        <span key={segment.section}>
          {index > 0 ? " · " : null}
          <span className={sectionColors[segment.section]}>{segment.text}</span>
        </span>
      ))}
    </>
  );
}

function HomeProjectPicker({
  projects,
  selectedProjectKey,
  onSelect,
}: {
  projects: ReadonlyArray<EnvironmentProject>;
  selectedProjectKey: string | null;
  onSelect: (key: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const projectItems = projects.map((project) => ({
    value: projectKeyOf(project),
    label: project.title,
    project,
    action: "project" as const,
  }));
  const items = [
    ...projectItems,
    { value: "__none__", label: "No project", project: null, action: "none" as const },
    { value: "__add__", label: "Add project…", project: null, action: "add" as const },
  ];
  const filteredItems = items.filter(
    (item) =>
      item.action !== "add" || query.length === 0
      ? item.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
      : false,
  );
  const selected =
    projectItems.find((item) => item.value === selectedProjectKey) ??
    items.find((item) => item.action === "none")!;

  return (
    <Combobox
      items={items}
      filteredItems={filteredItems}
      value={selected}
      onValueChange={(item) => {
        if (!item) return;
        if (item.action === "add") {
          openCommandPalette({ open: "add-project" });
        } else {
          onSelect(item.action === "none" ? null : item.value);
        }
      }}
      itemToStringLabel={(item) => item.label}
      isItemEqualToValue={(a, b) => a.value === b.value}
    >
      <ComboboxTrigger className="flex h-7 min-w-0 max-w-52 items-center gap-1.5 rounded-md border border-border/70 bg-background/50 px-2 text-xs text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
        {selected.project ? (
          <ProjectFavicon project={selected.project} className="size-3.5 shrink-0" />
        ) : (
          <FolderIcon className="size-3.5 shrink-0" />
        )}
        <span className="truncate">{selected.label}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </ComboboxTrigger>
      <ComboboxPopup className="w-[min(18rem,var(--available-width))] overflow-hidden">
        <ComboboxSearchInput
          aria-label="Search projects"
          placeholder="Search projects..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ComboboxEmpty>No matching projects.</ComboboxEmpty>
        <ComboboxList>
          {(item: (typeof items)[number]) => (
            <ComboboxItem key={item.value} value={item}>
              {item.project ? (
                <ProjectFavicon project={item.project} className="size-4 shrink-0" />
              ) : item.action === "add" ? (
                <FolderPlusIcon className="size-4 shrink-0" />
              ) : (
                <FolderIcon className="size-4 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.value === selected.value ? <CheckIcon className="size-4" /> : null}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}

function HomeThreadComposer({
  project,
  canSend,
  projectControl,
}: {
  project: EnvironmentProject;
  canSend: boolean;
  projectControl: ReactNode;
}) {
  const handleNewThread = useNewThreadHandler();
  const [draft, setDraft] = useState<NonNullable<Awaited<ReturnType<NewThreadHandler>>> | null>(null);
  useEffect(() => {
    let active = true;
    setDraft(null);
    void handleNewThread(scopeProjectRef(project.environmentId, project.id), { navigate: false }).then(
      (result) => {
        if (active && result) setDraft(result);
      },
    );
    return () => {
      active = false;
    };
  }, [project.environmentId, project.id, handleNewThread]);
  if (!draft) return null;
  return (
    <ChatView
      environmentId={project.environmentId}
      threadId={draft.threadId}
      routeKind="draft"
      draftId={draft.draftId}
      homeComposerOnly
      homeComposerProjectSelected={canSend}
      homeProjectControl={projectControl}
    />
  );
}

function projectKeyOf(project: EnvironmentProject): string {
  return projectKey(scopeProjectRef(project.environmentId, project.id));
}

function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining === 0 ? `${hours}h` : `${hours}h ${remaining}m`;
}

function HomeQuestionIndex({ row, onText }: { row: HomeRow; onText: (key: string, text: string) => void }) {
  const ref = homeThreadRef(row.thread);
  const pending = useAtomValue(environmentThreadDetails.pendingRequestsAtom(ref));
  const key = threadKey({ environmentId: row.thread.environmentId, threadId: row.thread.id });
  const text = [
    ...((pending?.approvals ?? []).flatMap((item) => [item.requestKind, item.detail ?? ""])),
    ...((pending?.userInputs ?? []).flatMap((item) => item.questions.map((question) => question.question))),
  ].join(" ");
  useEffect(() => onText(key, text), [key, onText, text]);
  return null;
}

function HomeNeedsPanel({
  thread,
  onOpen,
  expanded,
  onExpandedChange,
}: {
  thread: ReturnType<typeof useVisibleThreadShells>[number];
  onOpen: () => void;
  expanded: boolean;
  onExpandedChange: (open: boolean) => void;
}) {
  const ref = homeThreadRef(thread);
  const pending = useAtomValue(environmentThreadDetails.pendingRequestsAtom(ref));
  const respondToApproval = useOrchestrationCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const respondToUserInput = useOrchestrationCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [rejectReason, setRejectReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [sent, setSent] = useState(false);
  const approval = pending?.approvals[0];
  const userInput = pending?.userInputs[0];

  const answerQuestion = (question: NonNullable<typeof userInput>["questions"][number]) => {
    const answer = answers[question.id];
    if (Array.isArray(answer)) return answer;
    if (typeof answer === "string" && answer.length > 0) return answer;
    return question.initialAnswer ?? "";
  };
  const submitAnswers = async () => {
    if (!userInput) return;
    const completed = Object.fromEntries(
      userInput.questions.map((question) => [question.id, answerQuestion(question)]),
    );
    if (
      userInput.questions.some((question) => {
        const answer = completed[question.id];
        return (
          question.required !== false &&
          (Array.isArray(answer) ? answer.length === 0 : !answer?.trim())
        );
      })
    )
      return;
    const result = await respondToUserInput({
      environmentId: thread.environmentId,
      input: { threadId: thread.id, requestId: userInput.requestId, answers: completed },
    });
    if (result._tag === "Success") setSent(true);
  };
  const decideApproval = async (decision: "accept" | "decline") => {
    if (!approval) return;
    const reason = decision === "decline" ? rejectReason.trim() : "";
    const result = await respondToApproval({
      environmentId: thread.environmentId,
      input: {
        threadId: thread.id,
        requestId: approval.requestId,
        decision,
        ...(reason ? { feedback: reason } : {}),
      },
    });
    if (result._tag !== "Success") return;
    setRejecting(false);
    setRejectReason("");
    setSent(true);
  };
  const details = (
    <details
      className="ml-auto text-xs text-muted-foreground"
      open={expanded}
      onToggle={(event) => onExpandedChange(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-1 hover:text-foreground">
        Details <ChevronDownIcon className="size-3" />
      </summary>
      <div className="mt-2 border-t border-border/70 pt-2 text-xs text-muted-foreground">
        {approval ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt>Request</dt><dd>{approval.requestKind}</dd>
            <dt>Details</dt><dd className="whitespace-pre-wrap">{approval.detail ?? "No additional details."}</dd>
            <dt>Thread</dt><dd>{thread.title || "New thread"}</dd>
          </dl>
        ) : userInput ? (
          <div className="space-y-2">
            {userInput.questions.map((question) => (
              <div key={question.id}>
                <p className="font-medium text-foreground">{question.question}</p>
                {question.options.map((option) => <p key={option.value ?? option.label}>{option.label}</p>)}
              </div>
            ))}
          </div>
        ) : (
          <p>{thread.pendingSubagentRequest ?? "Additional request details are unavailable."}</p>
        )}
      </div>
    </details>
  );

  if (sent) return <p className="mt-2 text-xs text-success">Sent to thread</p>;
  if (approval) {
    return (
      <div className="mt-2">
        <h3 className="text-sm font-semibold leading-5">{approval.detail ?? approval.requestKind}</h3>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Button size="xs" onClick={() => void decideApproval("accept")} disabled={approval.responseCapability !== "live"}>
            Approve
          </Button>
          <Button size="xs" variant="outline" onClick={() => setRejecting(true)} disabled={approval.responseCapability !== "live"}>
            Reject
          </Button>
          <HomeSnoozeMenu threadRef={ref} />
          <Button size="xs" variant="ghost" onClick={onOpen}>Open</Button>
          {details}
        </div>
        {rejecting ? (
          <div className="mt-2 flex flex-wrap gap-2">
            <input
              className="h-8 min-w-48 flex-1 rounded-md border border-border/70 bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Rejection reason (optional)"
              placeholder="Reason, optional. Sent to the thread as a message."
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
            />
            <Button size="xs" onClick={() => void decideApproval("decline")}>Send rejection</Button>
            <Button size="xs" variant="ghost" onClick={() => setRejecting(false)}>Cancel</Button>
          </div>
        ) : null}
      </div>
    );
  }
  if (userInput) {
    return (
      <div className="mt-2 space-y-2">
        {userInput.questions.map((question) => (
          <fieldset key={question.id} className="space-y-1">
            <legend className="text-sm font-semibold leading-5">{question.question}</legend>
            <div className="flex flex-wrap gap-1.5">
              {question.options.map((option) => {
                const value = option.value ?? option.label;
                const answer = answerQuestion(question);
                const selected = Array.isArray(answer) ? answer.includes(value) : answer === value;
                const label = option.label.replace(/\s*\(Recommended\)\s*/iu, "");
                return (
                  <label key={value} className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border/70 px-2 py-1 text-xs">
                    <input
                      type={question.multiSelect ? "checkbox" : "radio"}
                      name={`${thread.id}-${question.id}`}
                      checked={selected}
                      onChange={() =>
                        setAnswers((current) => ({
                          ...current,
                          [question.id]: question.multiSelect
                            ? (Array.isArray(current[question.id]) ? current[question.id] as string[] : []).includes(value)
                              ? (current[question.id] as string[]).filter((entry) => entry !== value)
                              : [...(Array.isArray(current[question.id]) ? current[question.id] as string[] : []), value]
                            : value,
                        }))
                      }
                    />
                    {label}
                    {label !== option.label ? <span className="text-info-foreground">Recommended</span> : null}
                  </label>
                );
              })}
              {question.allowCustomAnswer !== false ? (
                <input
                  className="h-7 min-w-32 flex-1 rounded-md border border-border/70 bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Other answer for ${question.question}`}
                  placeholder="Other…"
                  value={typeof answers[question.id] === "string" && answers[question.id] !== question.initialAnswer ? answers[question.id] : ""}
                  onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
                />
              ) : null}
            </div>
          </fieldset>
        ))}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="xs" onClick={() => void submitAnswers()}>Send answer</Button>
          <HomeSnoozeMenu threadRef={ref} />
          <Button size="xs" variant="ghost" onClick={onOpen}>Open</Button>
          {details}
        </div>
      </div>
    );
  }
  return (
    <div className="mt-2 flex items-center gap-1.5">
      <span className="min-w-0 flex-1 text-sm font-medium">{thread.pendingSubagentRequest ?? "Waiting for your response"}</span>
      <HomeSnoozeMenu threadRef={ref} />
      <Button size="xs" variant="ghost" onClick={onOpen}>Open</Button>
      {details}
    </div>
  );
}

export function HomeSidebarLink({
  counts,
  active,
  onClick,
}: {
  counts: { needs: number; done: number; running: number };
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`sticky top-0 z-10 mb-2 flex w-full items-center gap-3 border-b px-3 py-3 text-left ${active ? "bg-accent" : "bg-sidebar"}`}
    >
      <HomeIcon className="size-5 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">Home</span>
        <span className="block truncate text-2xs text-muted-foreground">
          <HomeCountSummary counts={counts} doneLabel="done" />
        </span>
      </span>
    </button>
  );
}
