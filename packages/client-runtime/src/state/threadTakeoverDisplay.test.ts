// Slice B WP4 (plan-b-r6 §7, §9 tests 10 and 10b): a child a takeover moved from P to S shows as
// S's direct subagent, and only S waits on it. `[F]` assertions are red on cc15112571, whose
// shells and readers know only the lineage parent; `[G]` pass on both.
import {
  EnvironmentId,
  NodeId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2WaitTarget,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { presentThreadShell } from "./models.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { deriveThreadRelationshipGraph } from "./threadRelationships.ts";
import { resolveListedAncestorThreadRef } from "./threadShell.ts";
import { visibilityParentKey } from "./threadTagFilter.ts";
import { resolveThreadWaits, threadWaitKey } from "./threadWait.ts";
import { threadKey } from "./entities.ts";
import { threadFamilyRowsMissingFromShell } from "./threadFamilies.ts";

const env = EnvironmentId.make("env-takeover");
const P = ThreadId.make("p");
const S = ThreadId.make("s");
const T = ThreadId.make("t");
const C = ThreadId.make("c");
const G = ThreadId.make("g");
const Q = ThreadId.make("q");

const raw = (id: ThreadId, overrides: Partial<OrchestrationV2ThreadShell> = {}) =>
  ({
    ...v2ThreadShell,
    id,
    title: `Thread ${id}`,
    lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
    ...overrides,
  }) satisfies OrchestrationV2ThreadShell;

/** A top-level thread whose turn completed with nothing of its own left: the server says ended. */
const done = (id: ThreadId, overrides: Partial<OrchestrationV2ThreadShell> = {}) =>
  raw(id, {
    waitPhase: "ended",
    waitingOn: [],
    status: "completed",
    latestRunId: `run-${id}` as never,
    ...overrides,
  });

/** A top-level thread whose own turn still runs. */
const working = (id: ThreadId) =>
  raw(id, {
    waitPhase: "working",
    waitingOn: [],
    status: "running",
    latestRunId: `run-${id}` as never,
    activeRunId: `run-${id}` as never,
    activityRunStatus: "running",
  });

/** As the server projects S once its turn ended: its anchor is a roster target. */
const ownerWaitingOn = (id: ThreadId, child: ThreadId): OrchestrationV2ThreadShell =>
  done(id, {
    waitPhase: "waiting",
    waitingOn: [
      {
        source: "awaited_child",
        environmentId: null,
        threadId: child,
        title: `Thread ${child}`,
        taskId: `takeover:${child}`,
      } satisfies OrchestrationV2WaitTarget,
    ],
  });

/** C, created by P, moved to `owner`; its open run was started by `sender`. */
const movedChild = (input: {
  readonly owner: ThreadId;
  readonly former: ReadonlyArray<ThreadId>;
  readonly sender: ThreadId | null;
  readonly active?: boolean;
}) =>
  raw(C, {
    lineage: { rootThreadId: P, parentThreadId: P, relationshipToParent: "subagent" },
    ownerThreadId: input.owner,
    formerOwnerThreadIds: [...input.former],
    latestRunSenderThreadId: input.sender,
    ...(input.active === false
      ? { waitPhase: "ended", waitingOn: [], status: "completed", latestRunId: "run-c" as never }
      : {
          waitPhase: "working",
          waitingOn: [],
          status: "running",
          latestRunId: "run-c" as never,
          activeRunId: "run-c" as never,
          activityRunStatus: "running",
        }),
  } as Partial<OrchestrationV2ThreadShell>);

const resolve = (threads: ReadonlyArray<OrchestrationV2ThreadShell>) =>
  resolveThreadWaits({
    threads: threads.map((thread) => presentThreadShell(env, thread)),
    environmentReady: () => true,
  });
const waitOf = (result: ReturnType<typeof resolve>, id: ThreadId) =>
  result.get(threadWaitKey(env, id));
const targetIds = (result: ReturnType<typeof resolve>, id: ThreadId) =>
  (waitOf(result, id)?.targets ?? []).map((target) => target.threadId);

describe("takeover display: the moved child is the successor's direct subagent (test 10)", () => {
  it("nests C, and C's own subagent, under S in thread lists, tags and relationships", () => {
    const child = movedChild({ owner: S, former: [P], sender: P });
    const grandchild = raw(G, {
      lineage: { rootThreadId: P, parentThreadId: C, relationshipToParent: "subagent" },
    });
    const shells = [done(P), ownerWaitingOn(S, C), child, grandchild].map((thread) =>
      presentThreadShell(env, thread),
    );
    // [F] the sidebar row that represents C and its grandchild is S's.
    expect(resolveListedAncestorThreadRef({ environmentId: env, threadId: C }, shells)).toEqual({
      environmentId: env,
      threadId: S,
    });
    expect(resolveListedAncestorThreadRef({ environmentId: env, threadId: G }, shells)).toEqual({
      environmentId: env,
      threadId: S,
    });
    // [F] the tag filter takes C's visibility from S.
    expect(visibilityParentKey(env, child)).toBe(threadKey({ environmentId: env, threadId: S }));

    // [F] relationships, read from P's view: P's moved task no longer links C; S does, and C keeps G.
    const movedTask = {
      id: NodeId.make("node:p-task"),
      childThreadId: C,
      status: "completed",
      transferredTo: { threadId: S, taskId: NodeId.make("node:s-anchor"), transferId: "x" },
    };
    const graph = deriveThreadRelationshipGraph({
      threads: [done(P), ownerWaitingOn(S, C), child, grandchild],
      projection: {
        thread: { ...done(P), ownership: undefined },
        subagents: [movedTask],
        contextTransfers: [],
      } as never,
    });
    const edges = graph.edges.map((edge) => `${edge.sourceThreadId}->${edge.targetThreadId}`);
    expect(edges).toContain("s->c");
    expect(edges).toContain("c->g");
    expect(edges).not.toContain("p->c");
  });

  it("opening C directly with S trimmed: the route's family read restores S above C and G", () => {
    // The route reads C's detail (a thread with `ownership`, no shell `ownerThreadId`) and mounts
    // C's family (ThreadRouteView useOpenThreadFamily). The server's family of C is S's display
    // family: S, C and G, without P (ProjectionStore familyOf).
    const detail = {
      lineage: { rootThreadId: P, parentThreadId: P, relationshipToParent: "subagent" as const },
      ownership: { ownerThreadId: S },
    };
    expect(visibilityParentKey(env, detail as never)).toBe(
      threadKey({ environmentId: env, threadId: S }),
    );
    const grandchild = raw(G, {
      lineage: { rootThreadId: P, parentThreadId: C, relationshipToParent: "subagent" },
    });
    const family = [
      ownerWaitingOn(S, C),
      movedChild({ owner: S, former: [P], sender: P }),
      grandchild,
    ];
    const shell = [done(P)];
    const merged = [
      ...shell,
      ...threadFamilyRowsMissingFromShell({
        shellThreads: shell,
        families: [{ snapshotSequence: 1, threads: family }],
        removedAt: new Map(),
      }),
    ].map((thread) => presentThreadShell(env, thread));
    // The client needs no change: given that family, S becomes a row and the walk ends at S
    // (the red side of this case is the server read, ThreadTakeover.integration.test.ts).
    expect(merged.some((thread) => thread.id === S)).toBe(true);
    for (const id of [C, G]) {
      expect(resolveListedAncestorThreadRef({ environmentId: env, threadId: id }, merged)).toEqual({
        environmentId: env,
        threadId: S,
      });
    }
  });

  it("shows S Waiting on its subagent C in the sidebar, header and Home; P does not show C", () => {
    // Sidebar, header and Home all read `resolveThreadWaits`.
    const result = resolve([
      done(P),
      ownerWaitingOn(S, C),
      movedChild({ owner: S, former: [P], sender: P }),
    ]);
    const successor = waitOf(result, S);
    expect(successor?.waiting).toBe(true);
    expect(successor?.targets).toEqual([
      expect.objectContaining({ threadId: C, kind: "subagent", state: "live" }),
    ]);
    // [F] the unsettled predecessor (before S settles it) does not wait on the moved child.
    expect(waitOf(result, P)?.waiting).toBe(false);
    expect(targetIds(result, P)).not.toContain(C);
  });
});

describe("takeover display: Waiting senders normalised over former owners (test 10b)", () => {
  it("right after the takeover the predecessor's send drives S, not P", () => {
    // S's own phase ended with no roster target (an older server, or a reconnect gap): the
    // implicit child edge alone must name S.
    const result = resolve([done(P), done(S), movedChild({ owner: S, former: [P], sender: P })]);
    // [F] S is the driver of the moved child; P has no Waiting edge to C.
    expect(waitOf(result, S)?.waiting).toBe(true);
    expect(targetIds(result, S)).toEqual([C]);
    expect(waitOf(result, P)?.waiting).toBe(false);
    expect(targetIds(result, P)).toEqual([]);
  });

  it("a P follow-up to C with its run active lists C on S, not P, while S still works", () => {
    const result = resolve([done(P), working(S), movedChild({ owner: S, former: [P], sender: P })]);
    // [F] S lists C (and stays working, the .23 rule for a parent's own turn); P lists nothing.
    expect(targetIds(result, S)).toEqual([C]);
    expect(waitOf(result, S)?.waiting).toBe(false);
    expect(targetIds(result, P)).toEqual([]);
  });

  it("after P -> S -> T a P or S sender maps to T", () => {
    for (const sender of [P, S]) {
      const result = resolve([
        done(P),
        done(S),
        done(T),
        movedChild({ owner: T, former: [P, S], sender }),
      ]);
      // [F] only T waits on C.
      expect(waitOf(result, T)?.waiting, `sender ${sender}`).toBe(true);
      expect(targetIds(result, T), `sender ${sender}`).toEqual([C]);
      expect(waitOf(result, S)?.waiting, `sender ${sender}`).toBe(false);
      expect(waitOf(result, P)?.waiting, `sender ${sender}`).toBe(false);
    }
  });

  it("a third-party sender drives only while its run is active", () => {
    // [G] slice A unchanged: Q waits on C's open run; once it ends nobody waits on C.
    const live = resolve([done(Q), done(S), movedChild({ owner: S, former: [P], sender: Q })]);
    expect(waitOf(live, Q)?.waiting).toBe(true);
    expect(targetIds(live, Q)).toEqual([C]);
    const ended = resolve([
      done(Q),
      done(S),
      movedChild({ owner: S, former: [P], sender: Q, active: false }),
    ]);
    expect(waitOf(ended, Q)?.waiting).toBe(false);
    expect(waitOf(ended, S)?.waiting).toBe(false);
  });
});
