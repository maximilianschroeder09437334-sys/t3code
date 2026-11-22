import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { ProviderDriverKind } from "@t3tools/contracts";
import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleCheckIcon,
  CircleStopIcon,
  Clock3Icon,
  FolderIcon,
  FolderPlusIcon,
  HomeIcon,
  LayersIcon,
  LoaderCircleIcon,
  SearchIcon,
  SquarePenIcon,
} from "lucide-react";
import { isElectron } from "../../env";
import {
  LAST_USED_PROJECT_STORAGE_KEY,
  lastUsedProjectKeySchema,
  resolveDefaultProjectRef,
  useNewThreadHandler,
  type NewThreadHandler,
} from "../../hooks/useHandleNewThread";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useScratchProject } from "../../hooks/useScratchProject";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { sortScopedProjectsForSidebar, resolveSidebarThreadStatus } from "../Sidebar.logic";
import { useDelegatedUnderParent, useProjects, useVisibleThreadShells } from "../../state/entities";
import { useThreadWaits } from "../../state/threadWaits";
import { HomeWaitingOnLine } from "./HomeWaitingOnLine";
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
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { ComposerControl } from "../chat/ComposerControl";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { HomeSnoozeMenu } from "./HomeSnoozeMenu";
import {
  countHomeRows,
  deriveHomeRows,
  formatHomeDuration,
  formatHomeTimeLabel,
  homeComposerProjectRef,
  homeCountSegments,
  homeDurationMinutes,
  homeThreadWasStopped,
  homeThreadRef,
  type HomeRow,
  type HomeCounts,
  type HomeSection,
} from "./Home.logic";
import ChatView from "../ChatView";
import { useThreadHasUnsentDraft } from "../../composerDraftStore";

const labels: Record<HomeSection, string> = {
  needs: "Needs you",
  waiting: "Waiting",
  done: "Done since you looked",
  running: "Running",
};
const sectionColors: Record<HomeSection, string> = {
  needs: "text-warning-foreground",
  waiting: "text-muted-foreground",
  done: "text-success",
  running: "text-info-foreground",
};
/** Rows whose project is no longer listed (archived or still loading). */
const OTHER_PROJECTS_KEY = "__other__";

function projectKeyOf(project: EnvironmentProject): string {
  return scopedProjectKey(scopeProjectRef(project.environmentId, project.id));
}

const ROW_CLICK_IGNORED =
  "button, a, input, textarea, select, label, [role='button'], [role='menuitem'], [data-home-no-open]";

/** A click opens the thread unless it lands on a control, or is a text selection. */
function shouldOpenFromRowClick(row: HTMLElement, target: EventTarget): boolean {
  if (!(target instanceof Element) || !row.contains(target)) return false;
  if (target.closest(ROW_CLICK_IGNORED) !== null) return false;
  return window.getSelection()?.toString() === "";
}

export function HomeView() {
  const projects = useProjects();
  const threads = useVisibleThreadShells();
  const providersByEnvironment = useEnvironmentProviders();
  // The minute tick is a UTC "YYYY-MM-DDTHH:mm" string; without the zone, Date.parse reads it
  // as local time and every age shifts by the UTC offset.
  const now = `${useNowMinute()}:00.000Z`;
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const delegatedUnderParent = useDelegatedUnderParent();
  const waits = useThreadWaits();
  const rows = deriveHomeRows({
    threads,
    projects,
    now,
    lastVisitedAt: null,
    delegatedUnderParent,
    waits,
  });
  const counts = countHomeRows(rows);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [questionTextByThread, setQuestionTextByThread] = useState<Record<string, string>>({});
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({});
  // The app-wide last-used project (also written when a thread or draft opens), so the
  // Home composer preselects the project used last.
  const [lastUsedProjectKey, setLastUsedProjectKey] = useLocalStorage(
    LAST_USED_PROJECT_STORAGE_KEY,
    null,
    lastUsedProjectKeySchema,
  );
  const router = useRouter();
  const { settleThread } = useThreadActions();
  const { scratchEnvironmentId, openScratchProject } = useScratchProject();
  const { environments } = useEnvironments();
  // Recognise the scratch ("No project") project from the server config even while the
  // environment reconnects, as the sidebar does; creating one still needs a live connection.
  const scratchRootByEnvironment = new Map(
    environments.map((environment) => [
      environment.environmentId,
      environment.serverConfig?.scratchWorkspaceRoot ?? null,
    ]),
  );
  const isScratch = (project: EnvironmentProject) =>
    isScratchProject(project, scratchRootByEnvironment.get(project.environmentId));
  const activeProjects = projects.filter((project) => project.archivedAt == null);
  const sortedProjects = sortScopedProjectsForSidebar(activeProjects, threads, "updated_at");
  // "No project" (the scratch project) always comes last.
  const namedProjects = sortedProjects.filter((project) => !isScratch(project));
  const scratchProject = sortedProjects.find((project) => isScratch(project)) ?? null;
  const orderedProjects = scratchProject ? [...namedProjects, scratchProject] : namedProjects;
  const scratchTargetEnvironmentId = scratchEnvironmentId(null);
  const canPickNoProject = scratchProject !== null || scratchTargetEnvironmentId !== null;
  const knownProjectKeys = new Set(orderedProjects.map(projectKeyOf));
  const rowProjectKey = (row: HomeRow) =>
    knownProjectKeys.has(row.projectKey) ? row.projectKey : OTHER_PROJECTS_KEY;

  const onQuestionText = (key: string, text: string) => {
    setQuestionTextByThread((current) =>
      current[key] === text ? current : { ...current, [key]: text },
    );
  };

  const search = query.trim().toLocaleLowerCase();
  const candidates = rows.filter((row) => filter === "all" || rowProjectKey(row) === filter);
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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the DOM node of a notification deep link into view
  useEffect(() => {
    if (!deepLinkedItem) return;
    document
      .querySelector<HTMLElement>(`[data-home-item="${encodeURIComponent(deepLinkedItem)}"]`)
      ?.scrollIntoView({ block: "center" });
  }, [deepLinkedItem]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- document listener for the "/" search shortcut while Home is mounted
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const active = document.activeElement as HTMLElement | null;
      if (
        event.key !== "/" ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        /INPUT|TEXTAREA/.test(active?.tagName ?? "") ||
        active?.isContentEditable === true
      )
        return;
      event.preventDefault();
      document.querySelector<HTMLInputElement>('[aria-label="Search Home"]')?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // The last-used project wins; otherwise the first named project in sidebar order.
  const composerProjectRef =
    homeComposerProjectRef(activeProjects, lastUsedProjectKey) ??
    resolveDefaultProjectRef(namedProjects, projectOrder, null);
  const composerProject = composerProjectRef
    ? (activeProjects.find(
        (project) =>
          project.environmentId === composerProjectRef.environmentId &&
          project.id === composerProjectRef.projectId,
      ) ?? null)
    : null;
  const chooseNoProject = async () => {
    const project =
      scratchProject ??
      (scratchTargetEnvironmentId !== null
        ? await openScratchProject(scratchTargetEnvironmentId)
        : null);
    if (project) setLastUsedProjectKey(projectKeyOf(project));
  };

  const filterChip = (key: string, label: string, icon: ReactNode, count: number) => (
    <Button
      key={key}
      size="sm-pill"
      variant={filter === key ? "secondary" : "outline"}
      aria-pressed={filter === key}
      onClick={() => setFilter(key)}
    >
      {icon}
      {label}
      <span className="text-muted-foreground tabular-nums">{count}</span>
    </Button>
  );
  const otherRowsCount = rows.filter((row) => rowProjectKey(row) === OTHER_PROJECTS_KEY).length;
  const sections = (["needs", "waiting", "done", "running"] as const)
    .map((section) => ({ section, items: sectionRows(section) }))
    .filter(({ items }) => items.length > 0);

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
                key={threadKey({
                  environmentId: row.thread.environmentId,
                  threadId: row.thread.id,
                })}
                row={row}
                onText={onQuestionText}
              />
            ))
        : null}
      <WorkspacePageHeader electron={isElectron}>
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
          <HomeIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          Home
        </span>
      </WorkspacePageHeader>
      <header className="shrink-0 px-6 pt-5">
        <div className="mx-auto w-full max-w-(--chat-content-max-width)">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Home</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                <HomeCountSummary counts={counts} doneLabel="done since you looked" />
              </p>
            </div>
            <label className="flex h-8 w-full max-w-58 items-center gap-2 rounded-lg border border-border/70 bg-background px-2.5 text-sm text-muted-foreground focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring sm:w-58">
              <SearchIcon className="size-4 shrink-0" aria-hidden="true" />
              <input
                aria-label="Search Home"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search Home"
                className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
              />
              <kbd className="rounded border border-border/70 px-1 text-2xs leading-4">/</kbd>
            </label>
          </div>
          <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Filter by project">
            {filterChip("all", "All", null, rows.length)}
            {orderedProjects
              .filter((project) => rows.some((row) => row.projectKey === projectKeyOf(project)))
              .map((project) =>
                filterChip(
                  projectKeyOf(project),
                  project.title,
                  <ProjectFavicon project={project} className="size-4" />,
                  rows.filter((row) => row.projectKey === projectKeyOf(project)).length,
                ),
              )}
            {otherRowsCount > 0
              ? filterChip(
                  OTHER_PROJECTS_KEY,
                  "Other projects",
                  <FolderIcon className="size-4" />,
                  otherRowsCount,
                )
              : null}
          </div>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-44 pt-6 scrollbar-gutter-both">
        <div className="mx-auto w-full max-w-(--chat-content-max-width) space-y-7">
          {sections.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">
              {search || filter !== "all" ? "Nothing matches." : "Nothing on Home right now."}
            </p>
          ) : null}
          {sections.map(({ section, items }) => {
            const projectGroups: Array<{
              project: EnvironmentProject | null;
              rows: ReadonlyArray<HomeRow>;
            }> = orderedProjects
              .map((project) => ({
                project: project as EnvironmentProject | null,
                rows: items.filter((row) => row.projectKey === projectKeyOf(project)),
              }))
              .filter((group) => group.rows.length > 0);
            const otherRows = items.filter((row) => rowProjectKey(row) === OTHER_PROJECTS_KEY);
            if (otherRows.length > 0) projectGroups.push({ project: null, rows: otherRows });
            return (
              <section key={section} aria-labelledby={`home-${section}`}>
                <h2
                  id={`home-${section}`}
                  className={`mb-2 flex items-center gap-2 text-sm font-semibold ${sectionColors[section]}`}
                >
                  {labels[section]}
                  <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground tabular-nums">
                    {items.length}
                  </span>
                </h2>
                <div className="space-y-3">
                  {projectGroups.map((group) => {
                    const project = group.project;
                    const age = Math.max(
                      ...group.rows.map((row) => homeDurationMinutes(row.thread, now, row.wait)),
                    );
                    const timing =
                      group.rows.length >= 2 && (section === "needs" || section === "running")
                        ? `${section === "needs" ? "oldest waiting" : "longest running"} ${formatHomeDuration(age)}`
                        : null;
                    const groupKey = project ? projectKeyOf(project) : OTHER_PROJECTS_KEY;
                    return (
                      <div key={groupKey}>
                        <div className="mb-1.5 flex min-h-6 items-center gap-1.5 px-0.5 text-xs text-muted-foreground">
                          {project ? (
                            <ProjectFavicon project={project} className="size-4 shrink-0" />
                          ) : (
                            <FolderIcon className="size-4 shrink-0" />
                          )}
                          <span>{project?.title ?? "Other projects"}</span>
                          <span className={`tabular-nums ${sectionColors[section]}`}>
                            {group.rows.length}
                          </span>
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
                            const openThread = (thread: EnvironmentThreadShell) =>
                              void router.navigate({
                                to: "/$environmentId/$threadId",
                                params: {
                                  environmentId: thread.environmentId,
                                  threadId: thread.id,
                                },
                              });
                            return (
                              <HomeRowCard
                                key={key}
                                itemKey={key}
                                row={row}
                                now={now}
                                providerIcon={
                                  <ProviderInstanceIcon
                                    driverKind={
                                      provider?.driver ?? ProviderDriverKind.make("codex")
                                    }
                                    displayName={
                                      provider?.displayName ?? String(row.thread.providerInstanceId)
                                    }
                                    size="compact"
                                  />
                                }
                                onOpen={openThread}
                                onSettle={() => void settleThread(homeThreadRef(row.thread))}
                                expanded={expandedItems[key] ?? deepLinkedItem === key}
                                onExpandedChange={(open) =>
                                  setExpandedItems((current) => ({ ...current, [key]: open }))
                                }
                              />
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      </div>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-6 bg-background"
      />
      <div className="pointer-events-none absolute inset-0 z-30">
        {composerProject ? (
          <HomeThreadComposer
            key={projectKeyOf(composerProject)}
            project={composerProject}
            projectControl={
              <HomeProjectPicker
                projects={namedProjects}
                selected={composerProject}
                selectedIsScratch={isScratch(composerProject)}
                canPickNoProject={canPickNoProject}
                onSelect={(project) => setLastUsedProjectKey(projectKeyOf(project))}
                onSelectNoProject={() => void chooseNoProject()}
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

/** The sidebar's unsent-draft mark: the yellow pen, with its label. */
function HomeDraftTag() {
  return (
    <span
      aria-label="Unsent draft"
      className="inline-flex shrink-0 items-center gap-1 text-2xs font-semibold text-warning-foreground"
    >
      <SquarePenIcon aria-hidden className="size-3 shrink-0" />
      Draft
    </span>
  );
}

function HomeRowCard({
  itemKey,
  row,
  now,
  providerIcon,
  onOpen,
  onSettle,
  expanded,
  onExpandedChange,
}: {
  itemKey: string;
  row: HomeRow;
  now: string;
  providerIcon: ReactNode;
  onOpen: (thread: EnvironmentThreadShell) => void;
  onSettle: () => void;
  expanded: boolean;
  onExpandedChange: (open: boolean) => void;
}) {
  const [chainOpen, setChainOpen] = useState(false);
  const { thread } = row;
  const hasUnsentDraft = useThreadHasUnsentDraft(homeThreadRef(thread));
  const status = resolveSidebarThreadStatus(thread, row.wait);
  const stopped = homeThreadWasStopped(thread);
  const timeColor =
    status === "failed"
      ? "text-error-foreground"
      : row.section === "needs"
        ? "text-warning-foreground"
        : row.section === "running"
          ? "text-info-foreground"
          : stopped ||
              (row.section === "done" &&
                thread.lastVisitedAt != null &&
                Date.parse(thread.lastVisitedAt) >=
                  Date.parse(thread.latestRun?.completedAt ?? thread.updatedAt))
            ? "text-muted-foreground"
            : "text-success";
  const TimeIcon =
    row.section === "needs"
      ? Clock3Icon
      : stopped || status === "failed"
        ? CircleStopIcon
        : row.section === "done"
          ? CircleCheckIcon
          : LoaderCircleIcon;
  const title = thread.title || "New thread";
  const summary =
    thread.goal?.objective ??
    (row.section === "running" ? (thread.latestRun?.providerStartingLabel ?? null) : null);
  const chainToggle =
    row.predecessors.length > 0 ? (
      <button
        type="button"
        aria-expanded={chainOpen}
        onClick={() => setChainOpen((open) => !open)}
        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border/70 px-1.5 py-px text-2xs text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <LayersIcon className="size-3" aria-hidden="true" />
        {row.predecessors.length + 1} threads
        <ChevronDownIcon className={cn("size-3", chainOpen && "rotate-180")} aria-hidden="true" />
      </button>
    ) : null;
  const time = (
    <span className={cn("flex shrink-0 items-center gap-1.5 text-xs tabular-nums", timeColor)}>
      <TimeIcon className="size-3.5" aria-hidden="true" />
      {formatHomeTimeLabel(thread, now, undefined, row.wait)}
    </span>
  );

  return (
    <article
      data-home-item={encodeURIComponent(itemKey)}
      tabIndex={0}
      onClick={(event) => {
        if (shouldOpenFromRowClick(event.currentTarget, event.target)) onOpen(thread);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target === event.currentTarget) onOpen(thread);
      }}
      className="cursor-pointer rounded-xl border border-border/70 px-3.5 py-3 outline-none transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      {row.section === "needs" ? (
        <>
          <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            {providerIcon}
            <span className="min-w-0 truncate">{title}</span>
            {hasUnsentDraft ? <HomeDraftTag /> : null}
            {row.waitingCount ? (
              <span className="shrink-0 rounded-full border border-warning/40 px-2 py-0.5 text-2xs text-warning-foreground">
                {row.waitingCount}{" "}
                {row.waitingCount === 1 ? "thread waiting on this" : "threads waiting on this"}
              </span>
            ) : null}
            {chainToggle}
            <span className="ml-auto" />
            {time}
          </div>
          <HomeNeedsPanel
            thread={thread}
            askText={thread.homeAskText}
            onOpen={() => onOpen(thread)}
            expanded={expanded}
            onExpandedChange={onExpandedChange}
          />
        </>
      ) : (
        <>
          <div className="flex min-w-0 items-center gap-2">
            {providerIcon}
            <span className="min-w-0 truncate text-sm font-semibold text-foreground">{title}</span>
            {hasUnsentDraft ? <HomeDraftTag /> : null}
            {chainToggle}
            <span className="ml-auto" />
            {time}
          </div>
          <div className="mt-1 flex min-h-6 items-center gap-3 ps-6">
            {row.wait?.waiting === true ? (
              <HomeWaitingOnLine thread={thread} wait={row.wait} />
            ) : row.wait === undefined && row.section === "waiting" && row.waitingOn ? (
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                Waiting on{" "}
                <a
                  className="text-primary underline underline-offset-2"
                  href={`/${encodeURIComponent(row.waitingOn.environmentId)}/${encodeURIComponent(row.waitingOn.threadId)}`}
                >
                  {row.waitingOn.title}
                </a>
                {row.waitingThread?.homeFirstNextStep?.startsWith("Maxi:") ? (
                  <span className="text-warning-foreground"> → needs you</span>
                ) : null}
                {row.thread.homeAutoWaitActive ? (
                  <span className="ml-1 text-muted-foreground">auto</span>
                ) : null}
              </span>
            ) : (
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {summary}
              </span>
            )}
            <div className="flex shrink-0 items-center gap-1">
              <Button size="xs" variant="ghost" onClick={() => onOpen(thread)}>
                Open
              </Button>
              {row.section === "done" ? (
                <>
                  <Button size="xs" variant="ghost" onClick={onSettle}>
                    <CheckIcon /> Settle
                  </Button>
                  <HomeSnoozeMenu threadRef={homeThreadRef(thread)} />
                </>
              ) : null}
            </div>
          </div>
        </>
      )}
      {chainOpen ? (
        <ul className="mt-2 space-y-0.5 border-t border-border/70 pt-2 text-xs text-muted-foreground">
          {row.predecessors.map((previous) => (
            <li key={previous.id}>
              <button
                type="button"
                className="py-0.5 text-left hover:text-foreground"
                onClick={() => onOpen(previous)}
              >
                {previous.title} · settled by successor
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

type ProjectPickerItem =
  | { value: string; label: string; action: "project"; project: EnvironmentProject }
  | { value: string; label: string; action: "none" | "add"; project: null };

const NO_PROJECT_VALUE = "__none__";
const ADD_PROJECT_VALUE = "__add__";

function HomeProjectPicker({
  projects,
  selected,
  selectedIsScratch,
  canPickNoProject,
  onSelect,
  onSelectNoProject,
}: {
  projects: ReadonlyArray<EnvironmentProject>;
  selected: EnvironmentProject;
  selectedIsScratch: boolean;
  canPickNoProject: boolean;
  onSelect: (project: EnvironmentProject) => void;
  onSelectNoProject: () => void;
}) {
  const [query, setQuery] = useState("");
  const items: ProjectPickerItem[] = [
    ...projects.map((project) => ({
      value: projectKeyOf(project),
      label: project.title,
      action: "project" as const,
      project,
    })),
    ...(canPickNoProject
      ? [{ value: NO_PROJECT_VALUE, label: "No project", action: "none" as const, project: null }]
      : []),
    { value: ADD_PROJECT_VALUE, label: "Add project…", action: "add" as const, project: null },
  ];
  const search = query.trim().toLocaleLowerCase();
  const filteredItems = search
    ? items.filter(
        (item) => item.action !== "add" && item.label.toLocaleLowerCase().includes(search),
      )
    : items;
  const selectedValue = selectedIsScratch ? NO_PROJECT_VALUE : projectKeyOf(selected);
  const selectedItem = items.find((item) => item.value === selectedValue) ?? null;
  const firstExtra = items.find((item) => item.action !== "project");

  return (
    <Combobox
      items={items}
      filteredItems={filteredItems}
      autoHighlight
      value={selectedItem}
      onOpenChange={() => setQuery("")}
      onValueChange={(item) => {
        if (!item) return;
        if (item.action === "add") openCommandPalette({ open: "add-project" });
        else if (item.action === "none") onSelectNoProject();
        else if (item.project) onSelect(item.project);
      }}
      itemToStringLabel={(item) => item.label}
      isItemEqualToValue={(a, b) => a.value === b.value}
    >
      <ComboboxTrigger
        render={<ComposerControl />}
        aria-label={`Project: ${selectedIsScratch ? "No project" : selected.title}`}
        className="max-w-48 min-w-0"
      >
        <ProjectFavicon project={selected} className="size-4 shrink-0" />
        <span className="truncate">{selectedIsScratch ? "No project" : selected.title}</span>
      </ComboboxTrigger>
      <ComboboxPopup side="top" align="start" className="w-72 overflow-hidden">
        <ComboboxSearchInput
          aria-label="Search projects"
          placeholder="Search projects..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ComboboxEmpty>No matching projects.</ComboboxEmpty>
        <ComboboxList>
          {(item: ProjectPickerItem) => (
            <ComboboxItem
              key={item.value}
              hideIndicator
              value={item}
              className={cn(!search && item.value === firstExtra?.value && "mt-1.5")}
            >
              {item.project ? (
                <ProjectFavicon project={item.project} className="size-4 shrink-0" />
              ) : item.action === "add" ? (
                <FolderPlusIcon className="size-4 shrink-0" />
              ) : (
                <NoProjectIcon />
              )}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.value === selectedValue ? <CheckIcon className="size-4" /> : null}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}

/** The dashed frame "No project" uses elsewhere in the app. */
function NoProjectIcon() {
  return (
    <span
      aria-hidden="true"
      className="mx-px inline-block size-3.5 shrink-0 rounded-xs border border-dashed border-muted-foreground"
    />
  );
}

function HomeThreadComposer({
  project,
  projectControl,
}: {
  project: EnvironmentProject;
  projectControl: ReactNode;
}) {
  const handleNewThread = useNewThreadHandler();
  const [draft, setDraft] = useState<NonNullable<Awaited<ReturnType<NewThreadHandler>>> | null>(
    null,
  );
  // Keyed by project, so this runs once per project: it opens (or reuses) that project's
  // composer draft in the draft store and keeps its id while Home shows it.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- creates the project's draft in the external composer draft store
  useEffect(() => {
    let active = true;
    void handleNewThread(scopeProjectRef(project.environmentId, project.id), {
      navigate: false,
    }).then((result) => {
      if (active && result) setDraft(result);
    });
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
      homeProjectControl={projectControl}
    />
  );
}

function HomeQuestionIndex({
  row,
  onText,
}: {
  row: HomeRow;
  onText: (key: string, text: string) => void;
}) {
  const ref = homeThreadRef(row.thread);
  const pending = useAtomValue(environmentThreadDetails.pendingRequestsAtom(ref));
  const key = threadKey({ environmentId: row.thread.environmentId, threadId: row.thread.id });
  const text = [
    ...(pending?.approvals ?? []).flatMap((item) => [item.requestKind, item.detail ?? ""]),
    ...(pending?.userInputs ?? []).flatMap((item) =>
      item.questions.map((question) => question.question),
    ),
  ].join(" ");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pending-request text lives in per-thread atoms; this reports it to Home's search index
  useEffect(() => onText(key, text), [key, onText, text]);
  return null;
}

function HomeNeedsPanel({
  thread,
  askText,
  onOpen,
  expanded,
  onExpandedChange,
}: {
  thread: EnvironmentThreadShell;
  askText?: string | null | undefined;
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
  const [otherOpen, setOtherOpen] = useState<Record<string, boolean>>({});
  const [rejectReason, setRejectReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [sent, setSent] = useState(false);
  const approval = pending?.approvals[0];
  const userInput = pending?.userInputs[0];

  const answerQuestion = (
    question: NonNullable<typeof userInput>["questions"][number],
    overrides: Record<string, string | string[]> = {},
  ) => {
    const answer = overrides[question.id] ?? answers[question.id];
    if (Array.isArray(answer)) return answer;
    if (typeof answer === "string" && answer.length > 0) return answer;
    return question.initialAnswer ?? "";
  };
  const submitAnswers = async (overrides: Record<string, string | string[]> = {}) => {
    if (!userInput) return;
    const completed = Object.fromEntries(
      userInput.questions.map((question) => [question.id, answerQuestion(question, overrides)]),
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
  const detailsToggle = (
    <Button
      size="xs"
      variant="ghost-muted"
      className="ml-auto"
      aria-expanded={expanded}
      onClick={() => onExpandedChange(!expanded)}
    >
      Details
      {expanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
    </Button>
  );
  const detailRow = (label: string, value: ReactNode) => (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 whitespace-pre-wrap break-words text-foreground">{value}</dd>
    </>
  );
  const threadLink = (
    <button type="button" className="text-info-foreground hover:underline" onClick={onOpen}>
      {thread.title || "New thread"}
    </button>
  );
  const detailsPanel = expanded ? (
    <dl className="mt-3 grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-4 gap-y-2 border-t border-border/70 pt-3 text-xs">
      {approval ? (
        <>
          {detailRow("Request", approval.requestKind)}
          {detailRow("Details", approval.detail ?? "No additional details.")}
        </>
      ) : userInput ? (
        userInput.questions.map((question) => (
          <div key={question.id} className="contents">
            {detailRow(
              question.header,
              <>
                {question.question}
                {question.options.length > 0 ? (
                  <ul className="mt-1 space-y-0.5 text-muted-foreground">
                    {question.options.map((option) => (
                      <li key={option.value ?? option.label}>
                        {option.label}
                        {option.description && option.description !== option.label
                          ? ` – ${option.description}`
                          : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>,
            )}
          </div>
        ))
      ) : (
        detailRow("Request", thread.pendingSubagentRequest ?? "Waiting for your response.")
      )}
      {detailRow("Thread", threadLink)}
    </dl>
  ) : null;

  if (sent) return <p className="mt-2 text-xs text-success">Sent to thread</p>;
  if (approval) {
    return (
      <div className="mt-1.5">
        <h3 className="text-base font-semibold leading-6 text-foreground">
          {approval.detail ?? approval.requestKind}
        </h3>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Button
            size="xs"
            onClick={() => void decideApproval("accept")}
            disabled={approval.responseCapability !== "live"}
          >
            Approve
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={() => setRejecting(true)}
            disabled={approval.responseCapability !== "live"}
          >
            Reject
          </Button>
          <HomeSnoozeMenu threadRef={ref} />
          <Button size="xs" variant="ghost" onClick={onOpen}>
            Open
          </Button>
          {detailsToggle}
        </div>
        {rejecting ? (
          <div className="mt-2 flex flex-wrap gap-2">
            <input
              autoFocus
              className="h-7 min-w-48 flex-1 rounded-md border border-border/70 bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              aria-label="Rejection reason (optional)"
              placeholder="Reason, optional. Sent to the thread as a message."
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void decideApproval("decline");
                if (event.key === "Escape") setRejecting(false);
              }}
            />
            <Button size="xs" onClick={() => void decideApproval("decline")}>
              Send rejection
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setRejecting(false)}>
              Cancel
            </Button>
          </div>
        ) : null}
        {detailsPanel}
      </div>
    );
  }
  if (userInput) {
    // One single-choice question answers on click; anything larger collects the
    // choices first and sends them together.
    const answersOnClick =
      userInput.questions.length === 1 && userInput.questions[0]?.multiSelect !== true;
    const actions = (
      <>
        <HomeSnoozeMenu threadRef={ref} />
        <Button size="xs" variant="ghost" onClick={onOpen}>
          Open
        </Button>
        {detailsToggle}
      </>
    );
    return (
      <div className="mt-1.5 space-y-2">
        {userInput.questions.map((question) => {
          const answer = answerQuestion(question);
          const otherVisible = otherOpen[question.id] === true;
          const current = answers[question.id];
          const otherText =
            typeof current === "string" &&
            !question.options.some((option) => (option.value ?? option.label) === current)
              ? current
              : "";
          return (
            <fieldset key={question.id} className="space-y-2">
              <legend className="text-base font-semibold leading-6 text-foreground">
                {question.question}
              </legend>
              <div className="flex flex-wrap items-center gap-1.5">
                {question.options.map((option) => {
                  const value = option.value ?? option.label;
                  const selected = Array.isArray(answer)
                    ? answer.includes(value)
                    : answer === value;
                  const label = option.label.replace(/\s*\(Recommended\)\s*/iu, "");
                  const recommended = label !== option.label;
                  return (
                    <Button
                      key={value}
                      size="xs"
                      aria-pressed={answersOnClick ? undefined : selected}
                      variant={selected && !answersOnClick ? "warning-outline" : "outline"}
                      onClick={() => {
                        if (answersOnClick) {
                          void submitAnswers({ [question.id]: value });
                          return;
                        }
                        setAnswers((previousAnswers) => {
                          if (!question.multiSelect) {
                            return { ...previousAnswers, [question.id]: value };
                          }
                          const previous = previousAnswers[question.id];
                          const list = Array.isArray(previous) ? previous : [];
                          return {
                            ...previousAnswers,
                            [question.id]: list.includes(value)
                              ? list.filter((entry) => entry !== value)
                              : [...list, value],
                          };
                        });
                      }}
                    >
                      {label}
                      {recommended ? (
                        <span className="rounded-full border border-info/50 px-1.5 py-px text-2xs font-medium text-info-foreground">
                          Recommended
                        </span>
                      ) : null}
                    </Button>
                  );
                })}
                {question.allowCustomAnswer !== false && !otherVisible ? (
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    onClick={() =>
                      setOtherOpen((previous) => ({ ...previous, [question.id]: true }))
                    }
                  >
                    Other…
                  </Button>
                ) : null}
                {answersOnClick ? actions : null}
              </div>
              {otherVisible ? (
                <div className="flex flex-wrap gap-2">
                  <input
                    autoFocus
                    className="h-7 min-w-48 flex-1 rounded-md border border-border/70 bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    aria-label={`Other answer for ${question.question}`}
                    placeholder="Your answer"
                    value={otherText}
                    onChange={(event) =>
                      setAnswers((previous) => ({ ...previous, [question.id]: event.target.value }))
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && answersOnClick && otherText.trim()) {
                        void submitAnswers();
                      }
                    }}
                  />
                  {answersOnClick ? (
                    <Button
                      size="xs"
                      disabled={!otherText.trim()}
                      onClick={() => void submitAnswers()}
                    >
                      Send answer
                    </Button>
                  ) : null}
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      setOtherOpen((previous) => ({ ...previous, [question.id]: false }));
                      setAnswers((previous) => {
                        const next = { ...previous };
                        delete next[question.id];
                        return next;
                      });
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              ) : null}
            </fieldset>
          );
        })}
        {answersOnClick ? null : (
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="xs" onClick={() => void submitAnswers()}>
              Send answers
            </Button>
            {actions}
          </div>
        )}
        {detailsPanel}
      </div>
    );
  }
  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 text-base font-semibold leading-6 text-foreground">
          {askText ?? thread.pendingSubagentRequest ?? "Waiting for your response"}
        </span>
        <HomeSnoozeMenu threadRef={ref} />
        <Button size="xs" variant="ghost" onClick={onOpen}>
          Open
        </Button>
        {detailsToggle}
      </div>
      {detailsPanel}
    </div>
  );
}

export function HomeSidebarLink({
  counts,
  active,
  onClick,
}: {
  counts: HomeCounts;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg px-3 py-3.5 text-left text-sidebar-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        active ? "bg-sidebar-row-active" : "bg-sidebar-row-selected hover:bg-sidebar-row-hover",
      )}
    >
      <HomeIcon className="size-4.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">Home</span>
        <span className="mt-1 block truncate text-xs text-muted-foreground">
          {counts.needs + counts.done + counts.running > 0 ? (
            <HomeCountSummary counts={{ ...counts, waiting: 0 }} doneLabel="done" />
          ) : (
            "All clear"
          )}
        </span>
      </span>
    </button>
  );
}
