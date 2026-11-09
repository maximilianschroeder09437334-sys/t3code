import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ThreadId } from "@t3tools/contracts";
import { toKindScopedComposerContextId } from "@t3tools/shared/composerContextReferences";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import {
  handoffIsThreadWait,
  handoffThreadReferences,
  readHandoffThreadStates,
} from "./HandoffThreadRouting.ts";

const target = ThreadId.make("mcp:launch:routing-fixture");
const marker = `[Thread: Routing fixture; ref=${toKindScopedComposerContextId("thread", target)}]`;
const link = `t3-thread://v2/local/${target}`;
const hostedUrl = `https://app.t3.codes/threads/local/${encodeURIComponent(target)}`;
const hosted = `[Routing fixture](${hostedUrl})`;
const report = (step: string) =>
  `**What happened**\n- Codex: done.\n\n**Next steps in order**\n1. ${step}`;

describe("thread handoff parsing", () => {
  it("resolves copied hosted Markdown and decodes launch IDs exactly once", () => {
    expect(handoffThreadReferences(report(`Codex: ${hosted}: finish.`))).toEqual([
      { reference: hostedUrl, environmentId: "local", threadId: target },
    ]);
    expect(
      handoffThreadReferences(
        report("Codex: [fixture](https://app.t3.codes/threads/local/encoded%253Avalue): finish."),
      )[0]?.threadId,
    ).toBe("encoded%3Avalue");
    for (const url of [
      "https://app.t3.codes/threads/local/%ZZ",
      "https://app.t3.codes.evil/threads/local/fixture",
      "https://elsewhere/threads/local/fixture",
      "https://app.t3.codes/threads/local/mcp:launch:raw",
    ]) {
      expect(handoffThreadReferences(report(`Codex: [fixture](${url}): finish.`))).toEqual([]);
    }
  });
  it("extracts the exact marker and canonical link without reading narrative examples", () => {
    const text = `**What happened**\n- Example ${link}\n\n**Next steps in order**\n1. ${marker}: finish the check.\n2. Codex: WAIT on [fixture](<${link}>) to finish.`;
    expect(handoffThreadReferences(text)).toEqual([
      { reference: marker, contextId: toKindScopedComposerContextId("thread", target) },
      { reference: link, environmentId: "local", threadId: target },
    ]);
  });

  it.each([
    [`Codex: WAIT on ${hosted}.`, true],
    [`Codex: WAIT on ${hosted} to finish.`, true],
    [`Codex: WAIT on ${marker}.`, true],
    [`Codex: WAIT on ${marker} to finish the check.`, true],
    [`Codex: WAIT on [fixture](<${link}>).`, true],
    [`${marker}: finish the check.`, false],
    ["Codex: finish now, then WAIT on a thread.", false],
    ["Codex: WAIT on [THREAD].", false],
    ["Codex: wait for approval.", false],
  ])("recognizes a first-step wait: %s", (step, expected) => {
    expect(handoffIsThreadWait(report(step))).toBe(expected);
  });

  it("ignores fenced examples, malformed URLs and a wait in the second step", () => {
    expect(
      handoffThreadReferences(`\`\`\`\n${report(`Codex: WAIT on ${marker}.`)}\n\`\`\``),
    ).toEqual([]);
    expect(handoffThreadReferences(report("Codex: WAIT on <t3-thread://v2/local/%ZZ>."))).toEqual(
      [],
    );
    expect(handoffIsThreadWait(report(`Codex: finish now.\n2. Codex: WAIT on ${marker}.`))).toBe(
      false,
    );
  });
});

describe("trusted thread state", () => {
  it.effect("resolves exact local references from server projections, not report claims", () => {
    const reads: string[] = [];
    const layer = Layer.mock(ProjectionStore.ProjectionStoreV2)({
      listActiveShellIndex: () => Effect.succeed([{ id: target }] as never),
      getThreadShell: (id) => {
        reads.push(id);
        return Effect.succeed({
          status: "running",
          activeRunId: "real-run",
          pendingRuntimeRequest: null,
        } as never);
      },
    });
    return Effect.gen(function* () {
      const states = yield* readHandoffThreadStates(
        handoffThreadReferences(report(`Codex: ${hosted}: finish.`)),
        "local",
      );
      expect(states).toEqual([
        {
          reference: hostedUrl,
          threadId: target,
          available: true,
          status: "running",
          activeRunId: "real-run",
          stopRequested: false,
          needsUser: false,
        },
      ]);
      expect(reads).toEqual([target]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps stopped, idle, completed and user-blocked states truthful", () => {
    let shell: object | null = null;
    const layer = Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadShell: () => Effect.succeed(shell as never),
    });
    return Effect.gen(function* () {
      for (const status of ["idle", "completed", "interrupted", "failed", "waiting"]) {
        shell = {
          status,
          activeRunId: status === "waiting" ? "blocked-run" : null,
          latestRunStopRequested: true,
          pendingRuntimeRequest: { blocking: true },
        };
        const [state] = yield* readHandoffThreadStates(
          [{ reference: link, environmentId: "local", threadId: target }],
          "local",
        );
        expect(state).toMatchObject({ status, stopRequested: true, needsUser: true });
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "fails closed for missing identity, unknown refs, remote targets and read errors",
    () => {
      let reads = 0;
      const layer = Layer.mock(ProjectionStore.ProjectionStoreV2)({
        listActiveShellIndex: () => Effect.succeed([]),
        getThreadShell: () => {
          reads++;
          return Effect.fail(
            new ProjectionStore.ProjectionStoreReadError({
              threadId: target,
              cause: "fixture failure",
            }),
          );
        },
      });
      return Effect.gen(function* () {
        const refs = handoffThreadReferences(report(`${marker}: finish.`));
        expect((yield* readHandoffThreadStates(refs, "local"))[0]?.available).toBe(false);
        expect(
          (yield* readHandoffThreadStates(
            [{ reference: link, environmentId: "remote", threadId: target }],
            "local",
          ))[0]?.available,
        ).toBe(false);
        expect(
          (yield* readHandoffThreadStates(
            [{ reference: link, environmentId: "local", threadId: target }],
            undefined,
          ))[0]?.available,
        ).toBe(false);
        expect(reads).toBe(0);
        expect(
          (yield* readHandoffThreadStates(
            [{ reference: link, environmentId: "local", threadId: target }],
            "local",
          ))[0]?.available,
        ).toBe(false);
        expect(reads).toBe(1);
      }).pipe(Effect.provide(layer));
    },
  );
});
