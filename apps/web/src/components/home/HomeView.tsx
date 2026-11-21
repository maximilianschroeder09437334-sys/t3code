import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { projectKey, threadKey } from "@t3tools/client-runtime/state/entities";
import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { CheckIcon, ChevronDownIcon, HomeIcon, PlusIcon, SendIcon } from "lucide-react";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useNowMinute } from "../../hooks/useNowMinute";
import { sortScopedProjectsForSidebar } from "../Sidebar.logic";
import { useProjects, useVisibleThreadShells } from "../../state/entities";
import { openCommandPalette } from "../../commandPaletteBus";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { Button } from "../ui/button";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ProviderDriverKind } from "@t3tools/contracts";
import { useEnvironmentProviders } from "../../state/environments";
import { useAtomValue } from "@effect/atom-react";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { newMessageId } from "../../lib/utils";
import { deriveHomeRows, countHomeRows, homeThreadRef, type HomeSection } from "./Home.logic";

const labels: Record<HomeSection, string> = {
  needs: "Needs you",
  done: "Done since you looked",
  running: "Running",
};
const color: Record<HomeSection, string> = {
  needs: "text-warning-foreground",
  done: "text-success",
  running: "text-muted-foreground",
};
const HOME_PROJECT_KEY = "t3code:home:last-project:v1";

function readHomeProjectKey(): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(HOME_PROJECT_KEY);
  } catch {
    return null;
  }
}
function projectKeyOf(project: EnvironmentProject): string {
  return projectKey(scopeProjectRef(project.environmentId, project.id));
}
function rememberProject(project: EnvironmentProject) {
  try {
    localStorage.setItem(HOME_PROJECT_KEY, projectKeyOf(project));
  } catch {
    /* Browser storage may be disabled. */
  }
}

export function HomeView() {
  const projects = useProjects();
  const threads = useVisibleThreadShells();
  const providersByEnvironment = useEnvironmentProviders();
  const now = useNowMinute();
  const lastVisitedAt = null;
  const rows = deriveHomeRows({ threads, projects, now, lastVisitedAt });
  const counts = countHomeRows(rows);
  const [filter, setFilter] = useState("all");
  const [prompt, setPrompt] = useState("");
  const [projectKey, setProjectKey] = useState(readHomeProjectKey);
  const router = useRouter();
  const handleNewThread = useNewThreadHandler();
  const { settleThread, snoozeThread } = useThreadActions();
  const activeProjects = projects.filter((project) => project.archivedAt == null);
  const orderedProjects = sortScopedProjectsForSidebar(activeProjects, threads, "updated_at");
  const selectedProject =
    activeProjects.find((project) => projectKeyOf(project) === projectKey) ?? orderedProjects[0];
  const visible = filter === "all" ? rows : rows.filter((row) => row.projectKey === filter);
  const startThread = async () => {
    if (!selectedProject || !prompt.trim()) return;
    const opened = await handleNewThread(
      scopeProjectRef(selectedProject.environmentId, selectedProject.id),
      { prompt: prompt.trim() },
    );
    if (opened) {
      setPrompt("");
      rememberProject(selectedProject);
    }
  };
  const requestedItem = (router.state.location.search as { item?: unknown }).item;
  const itemKey = typeof requestedItem === "string" ? requestedItem : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a notification deep link must reveal and scroll its row after render
  useEffect(() => {
    if (!itemKey) return;
    document
      .querySelector<HTMLElement>(`[data-home-item="${encodeURIComponent(itemKey)}"]`)
      ?.scrollIntoView({ block: "center" });
  }, [itemKey]);
  const sectionRows = (section: HomeSection) => visible.filter((row) => row.section === section);

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-6 py-4">
        <div className="text-sm font-medium">
          Home{" "}
          <span className="ml-2 text-xs text-muted-foreground">
            {counts.needs} need you · {counts.done} done since you looked · {counts.running} running
          </span>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 scrollbar-gutter-both">
        <div className="mx-auto max-w-4xl py-5">
          <div className="mb-5 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={filter === "all" ? "secondary" : "outline"}
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
                    onClick={() => setFilter(key)}
                  >
                    {project.title}
                    <span className="ml-1 text-muted-foreground">
                      {rows.filter((row) => row.projectKey === key).length}
                    </span>
                  </Button>
                );
              })}
          </div>
          {(["needs", "done", "running"] as const).map((section) => (
            <section key={section} className="mb-7">
              <h2 className={`mb-2 text-sm font-semibold ${color[section]}`}>
                {labels[section]}{" "}
                <span className="ml-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {sectionRows(section).length}
                </span>
              </h2>
              {sectionRows(section).length === 0 ? (
                <p className="py-2 text-sm text-muted-foreground">
                  {section === "needs" ? "Nothing needs you right now." : "Nothing here."}
                </p>
              ) : (
                <div className="space-y-1">
                  {sectionRows(section).map(({ thread, projectName, predecessors }) => (
                    <article
                      key={`${thread.environmentId}:${thread.id}`}
                      data-home-item={encodeURIComponent(
                        threadKey({ environmentId: thread.environmentId, threadId: thread.id }),
                      )}
                      className="rounded-xl border border-border/70 px-3 py-2 hover:bg-muted/40"
                    >
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="rounded-md bg-muted px-2 py-1">{projectName}</span>
                        {(() => {
                          const provider = providersByEnvironment
                            .get(thread.environmentId)
                            ?.find((entry) => entry.instanceId === thread.providerInstanceId);
                          return (
                            <ProviderInstanceIcon
                              driverKind={provider?.driver ?? ProviderDriverKind.make("codex")}
                              displayName={
                                provider?.displayName ?? String(thread.providerInstanceId)
                              }
                              size="compact"
                            />
                          );
                        })()}
                        <span className="ml-auto">
                          {thread.runtime?.status === "failed" ? (
                            <span className="text-error">Failed</span>
                          ) : section === "running" ? (
                            `Updated ${formatRelativeTimeLabel(thread.updatedAt, Date.parse(`${now}:00.000Z`))}`
                          ) : null}
                        </span>
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-3">
                        <div className="min-w-0 truncate text-sm font-medium">
                          {thread.title || "New thread"}
                        </div>
                        <div className="flex shrink-0 gap-1">
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() =>
                              void router.navigate({
                                to: "/$environmentId/$threadId",
                                params: {
                                  environmentId: thread.environmentId,
                                  threadId: thread.id,
                                },
                              })
                            }
                          >
                            Open
                          </Button>
                          {section === "done" ? (
                            <>
                              <Button
                                size="xs"
                                variant="ghost"
                                aria-label="Settle"
                                onClick={() => void settleThread(homeThreadRef(thread))}
                              >
                                <CheckIcon />
                              </Button>
                              <Button
                                size="xs"
                                variant="ghost"
                                aria-label="Snooze"
                                onClick={() =>
                                  void snoozeThread(
                                    homeThreadRef(thread),
                                    new Date(Date.now() + 60 * 60 * 1000).toISOString(),
                                  )
                                }
                              >
                                Snooze
                              </Button>
                            </>
                          ) : null}
                        </div>
                      </div>
                      <details
                        className="mt-1 text-xs text-muted-foreground"
                        open={
                          itemKey ===
                          threadKey({ environmentId: thread.environmentId, threadId: thread.id })
                        }
                      >
                        <summary className="cursor-pointer">Details</summary>
                        <p className="py-2">{thread.title || "No additional details available."}</p>
                      </details>
                      {section === "needs" ? <HomeNeedsPanel thread={thread} /> : null}
                      {predecessors.length ? (
                        <details
                          className="mt-2 text-xs text-muted-foreground"
                          open={predecessors.some(
                            (previous) =>
                              itemKey ===
                              threadKey({
                                environmentId: previous.environmentId,
                                threadId: previous.id,
                              }),
                          )}
                        >
                          <summary className="cursor-pointer inline-flex items-center gap-1">
                            <ChevronDownIcon className="size-3" />
                            {predecessors.length} threads
                          </summary>
                          {predecessors.map((previous) => (
                            <button
                              key={previous.id}
                              data-home-item={encodeURIComponent(
                                threadKey({
                                  environmentId: previous.environmentId,
                                  threadId: previous.id,
                                }),
                              )}
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
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      </div>
      <form
        className="shrink-0 border-t px-6 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          void startThread();
        }}
      >
        <div className="mx-auto max-w-4xl rounded-xl border bg-card p-3">
          <div className="mb-2 flex gap-2">
            <select
              className="max-w-full rounded-md border bg-background px-2 py-1 text-xs"
              aria-label="Project"
              value={selectedProject ? projectKeyOf(selectedProject) : ""}
              onChange={(event) => {
                setProjectKey(event.target.value);
                try {
                  localStorage.setItem(HOME_PROJECT_KEY, event.target.value);
                } catch {
                  /* Browser storage may be disabled. */
                }
              }}
            >
              {orderedProjects.map((project) => (
                <option key={projectKeyOf(project)} value={projectKeyOf(project)}>
                  {project.title}
                </option>
              ))}
            </select>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => openCommandPalette({ open: "add-project" })}
            >
              <PlusIcon />
              Add project
            </Button>
          </div>
          <textarea
            className="min-h-12 w-full resize-y bg-transparent text-sm outline-none"
            placeholder="Enter opens a new thread with this prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void startThread();
              }
            }}
          />
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={!prompt.trim() || !selectedProject}>
              <SendIcon />
              Start thread
            </Button>
          </div>
        </div>
      </form>
    </main>
  );
}

function HomeNeedsPanel({ thread }: { thread: ReturnType<typeof useVisibleThreadShells>[number] }) {
  const ref = homeThreadRef(thread);
  const pending = useAtomValue(environmentThreadDetails.pendingRequestsAtom(ref));
  const respondToApproval = useOrchestrationCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const respondToUserInput = useOrchestrationCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const { snoozeThread } = useThreadActions();
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
      userInput.questions.map((question) => {
        const answer = answerQuestion(question);
        return [question.id, answer];
      }),
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
    if (result._tag === "Success") {
      if (reason) {
        await startTurn({
          environmentId: thread.environmentId,
          input: {
            threadId: thread.id,
            message: { messageId: newMessageId(), role: "user", text: reason, attachments: [] },
            modelSelection: thread.modelSelection,
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
          },
        });
      }
      setRejecting(false);
      setRejectReason("");
      setSent(true);
    }
  };

  if (sent) return <p className="mt-2 text-xs text-success">Sent to thread</p>;
  if (approval) {
    return (
      <div className="mt-2 space-y-2 text-xs">
        <p className="whitespace-pre-wrap text-muted-foreground">
          {approval.detail ?? approval.requestKind}
        </p>
        {rejecting ? (
          <div className="flex flex-wrap gap-2">
            <input
              className="min-w-48 flex-1 rounded-md border bg-background px-2 py-1"
              aria-label="Rejection reason"
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
            />
            <Button size="xs" variant="secondary" onClick={() => void decideApproval("decline")}>
              Send rejection
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setRejecting(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
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
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                void snoozeThread(ref, new Date(Date.now() + 60 * 60 * 1000).toISOString())
              }
            >
              Snooze
            </Button>
          </div>
        )}
      </div>
    );
  }
  if (userInput) {
    return (
      <div className="mt-3 space-y-3">
        {userInput.questions.map((question) => (
          <fieldset key={question.id} className="rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">{question.question}</legend>
            <div className="space-y-1">
              {question.options.map((option) => {
                const value = option.value ?? option.label;
                const answer = answerQuestion(question);
                const selected = Array.isArray(answer) ? answer.includes(value) : answer === value;
                const label = option.label.replace(/\s*\(Recommended\)\s*/iu, "");
                return (
                  <label key={value} className="flex items-center gap-2 py-1 text-sm">
                    <input
                      type={question.multiSelect ? "checkbox" : "radio"}
                      name={`${thread.id}-${question.id}`}
                      checked={selected}
                      onChange={() =>
                        setAnswers((current) => ({
                          ...current,
                          [question.id]: question.multiSelect
                            ? (Array.isArray(current[question.id])
                                ? (current[question.id] as string[])
                                : []
                              ).includes(value)
                              ? (current[question.id] as string[]).filter(
                                  (entry) => entry !== value,
                                )
                              : [
                                  ...(Array.isArray(current[question.id])
                                    ? (current[question.id] as string[])
                                    : []),
                                  value,
                                ]
                            : value,
                        }))
                      }
                    />
                    <span>{label}</span>
                    {label !== option.label ? (
                      <span className="text-xs text-muted-foreground">Recommended</span>
                    ) : null}
                  </label>
                );
              })}
              {question.allowCustomAnswer !== false ? (
                <input
                  className="mt-2 w-full rounded-md border bg-background px-2 py-1 text-sm"
                  aria-label={`Other answer for ${question.question}`}
                  placeholder="Other…"
                  value={
                    typeof answers[question.id] === "string" &&
                    answers[question.id] !== question.initialAnswer
                      ? answers[question.id]
                      : ""
                  }
                  onChange={(event) =>
                    setAnswers((current) => ({ ...current, [question.id]: event.target.value }))
                  }
                />
              ) : null}
            </div>
          </fieldset>
        ))}
        <Button size="sm" onClick={() => void submitAnswers()}>
          Send answers
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void snoozeThread(ref, new Date(Date.now() + 60 * 60 * 1000).toISOString())
          }
        >
          Snooze
        </Button>
      </div>
    );
  }
  return (
    <Button
      className="mt-2"
      size="xs"
      variant="ghost"
      onClick={() => void snoozeThread(ref, new Date(Date.now() + 60 * 60 * 1000).toISOString())}
    >
      Snooze
    </Button>
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
          <i className="text-warning-foreground not-italic">{counts.needs} need you</i> ·{" "}
          <i className="text-success not-italic">{counts.done} done</i> · {counts.running} running
        </span>
      </span>
    </button>
  );
}
