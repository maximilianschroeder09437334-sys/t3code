import * as TestClock from "effect/testing/TestClock";
import * as SourceControlProviders from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectSetup from "../project/ProjectSetupScriptRunner.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeZlib from "node:zlib";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  HandoffReadinessRecords,
  OrchestrationV2Run,
  OrchestrationV2RuntimeRequest,
  ThreadId,
  CommandId,
  GitCommandError,
  RunId,
  type HandoffRequest,
} from "@t3tools/contracts";
import { derive } from "@t3tools/provider-core/server/IdAllocator";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Git from "../git/GitManager.ts";
import * as Driver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Config from "../config.ts";
import * as Terminals from "../terminal/Manager.ts";
import * as Threads from "./ThreadManagementService.ts";
import * as Sessions from "./ProviderSessionManager.ts";
import * as Projects from "./ProjectStore.ts";
import * as Outbox from "./EffectOutbox.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { queryHandoffReadiness, summarizeHandoffReadiness } from "./CoreHandoffReadiness.ts";
import { handoffId } from "./CoreHandoff.ts";

const sourceId = ThreadId.make("readiness-source");
const childId = ThreadId.make("readiness-child");
const now = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
const selection = {
  instanceId: "codex",
  model: "fake",
  options: [{ id: "effort", value: "medium" }],
};
const decodeRecords = Schema.decodeUnknownSync(HandoffReadinessRecords);
const decodeRun = Schema.decodeEffect(OrchestrationV2Run);
const decodeRequest = Schema.decodeEffect(OrchestrationV2RuntimeRequest);
const recordsFor = (cwd: string, id = sourceId) =>
  decodeRecords({
    ...Object.fromEntries(
      Object.keys(HandoffReadinessRecords.fields)
        .filter((key) => key !== "thread")
        .map((key) => [key, []]),
    ),
    thread: {
      id,
      projectId: "readiness-project",
      title: "Readiness",
      providerInstanceId: "codex",
      modelSelection: selection,
      createdBy: "user",
      creationSource: "mcp",
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "physical",
      worktreePath: cwd,
      activeProviderThreadId: "provider-thread",
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
    },
    providerThreads: [
      {
        id: "provider-thread",
        driver: "codex",
        providerInstanceId: "codex",
        providerSessionId: "session",
        appThreadId: id,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
  });

// A synthetic on-disk Git fixture: write only fixture bytes, never run init/commit/update-ref/read-tree.
// The application GitManager helper and actual GitVcsDriver/VcsProcess then run real read-only Git.
const gitFixture = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path,
    digest = yield* Digest.Digest;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "p2-readiness-" });
  const write = (name: string, bytes: string | Uint8Array) =>
    Effect.gen(function* () {
      const file = path.join(cwd, name);
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* typeof bytes === "string"
        ? fs.writeFileString(file, bytes)
        : fs.writeFile(file, bytes);
    });
  const sha = (bytes: Uint8Array) =>
    digest.digest(Digest.sha1, bytes).pipe(Effect.map((value) => Buffer.from(value)));
  const object = (type: string, bytes: Uint8Array) =>
    Effect.gen(function* () {
      const data = Buffer.concat([Buffer.from(`${type} ${bytes.length}\0`), bytes]);
      const oid = (yield* sha(data)).toString("hex");
      yield* write(`.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`, NodeZlib.deflateSync(data));
      return oid;
    });
  const blobA = yield* object("blob", Buffer.from("a\n"));
  const blobB = yield* object("blob", Buffer.from("b\n"));
  const tree = (oid: string) =>
    object("tree", Buffer.concat([Buffer.from("100644 file.txt\0"), Buffer.from(oid, "hex")]));
  const treeA = yield* tree(blobA),
    treeB = yield* tree(blobB);
  const commit = (oid: string) =>
    object(
      "commit",
      Buffer.from(
        `tree ${oid}\nauthor Fixture <fixture@example.test> 1 +0000\ncommitter Fixture <fixture@example.test> 1 +0000\n\nfixture\n`,
      ),
    );
  const head = yield* commit(treeA),
    checkpoint = yield* commit(treeB);
  yield* write(".git/HEAD", "ref: refs/heads/physical\n");
  yield* write(
    ".git/config",
    "[core]\nrepositoryformatversion = 0\nbare = false\nfilemode = false\nautocrlf = false\n",
  );
  yield* write(".git/refs/heads/physical", head + "\n");
  yield* write(".git/refs/checkpoints/fixture", checkpoint + "\n");
  const entry = Buffer.alloc(72);
  entry.writeUInt32BE(0o100644, 24);
  Buffer.from(blobA, "hex").copy(entry, 40);
  entry.writeUInt16BE(8, 60);
  entry.write("file.txt", 62);
  const header = Buffer.alloc(12);
  header.write("DIRC");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(1, 8);
  const index = Buffer.concat([header, entry]);
  yield* write(".git/index", Buffer.concat([index, yield* sha(index)]));
  yield* write("file.txt", "a\n");
  return { cwd, head, checkpoint, write };
});
const layers = Outbox.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(
    Driver.layer.pipe(
      Layer.provide(VcsProcess.layer),
      Layer.provide(Config.layerTest(process.cwd(), { prefix: "p2-readiness-test-" })),
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

it.layer(layers)("CoreHandoff readiness", (it) => {
  it.effect(
    "retains physical Git identity and verifies the exact dirty checkpoint without any Git writes",
    () =>
      Effect.gen(function* () {
        const fixture = yield* gitFixture();
        const manager = yield* Git.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(SourceControlProviders.SourceControlProviderRegistry)({
                resolveLink: () => undefined,
              }),
              Layer.mock(TextGeneration.TextGeneration)({}),
              Layer.mock(ProviderRegistry.ProviderRegistry)({}),
              Layer.mock(ProjectSetup.ProjectSetupScriptRunner)({}),
              Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
              Layer.mock(Projects.ProjectStoreV2)({}),
              Layer.mock(ServerSettings.ServerSettingsService)({ streamChanges: Stream.empty }),
            ),
          ),
        );
        const clean = yield* manager.observeHandoffWorkspace(fixture.cwd, null);
        assert.equal(clean.branch, "physical");
        assert.equal(clean.head, fixture.head);
        assert.equal(clean.status, "");
        yield* fixture.write("file.txt", "b\n");
        const dirty = yield* manager.observeHandoffWorkspace(fixture.cwd, null);
        assert.notEqual(dirty.status, "");
        assert.isNull(dirty.checkpointMatches);
        const captured = yield* manager.observeHandoffWorkspace(
          fixture.cwd,
          "refs/checkpoints/fixture",
        );
        assert.equal(captured.checkpointCommit, fixture.checkpoint);
        assert.isTrue(captured.checkpointMatches);
        assert.notEqual(captured.worktreeDiff, "");
        assert.equal(captured.indexDiff, "");
      }),
  );

  it.effect.each([
    "unborn",
    "non-repo",
    "oversized",
    "settled-stale",
    "newer-run",
    "rewrite-run",
    "fork",
    "subagent",
    "side-chat",
    "successor",
    "chain-ready",
    "chain-pending",
    "contradictory",
    "non-context-handoff",
    "cap-run-missing",
    "cap-missing-proof",
    "cap-reconciled",
    "manual",
    "metadata",
    "dirty",
    "checkpoint",
    "checkpoint-timeout",
    "untracked-timeout",
    "unborn-checkpoint-change",
    "head-change",
    "run-change",
    "child-change",
    "active-child",
    "jobs",
    "approval",
    "queued",
    "provider-missing",
    "probe-missing",
    "probe-error",
    "terminal-array-missing",
    "child-array-missing",
    "terminal-missing",
    "read-error",
    "missing-array",
    "index-error",
  ])("observes %s without creating or resuming a successor", (scenario) =>
    Effect.gen(function* () {
      const fixture = yield* gitFixture();
      const driver = yield* Driver.GitVcsDriver;
      const capRunId = RunId.make("readiness-cap");
      const threadId = ThreadId.make(`readiness-source-${scenario}`);
      let records = recordsFor(fixture.cwd, threadId),
        reads = 0,
        sequences = 0,
        indexReads = 0;
      if (
        [
          "unborn",
          "non-repo",
          "oversized",
          "settled-stale",
          "newer-run",
          "rewrite-run",
          "checkpoint-timeout",
          "untracked-timeout",
          "unborn-checkpoint-change",
        ].includes(scenario) ||
        scenario === "cap-missing-proof" ||
        scenario === "cap-reconciled" ||
        scenario === "cap-run-missing"
      )
        records = decodeRecords({
          ...records,
          turnItems: [
            {
              id: derive.runSignalTurnItem({ runId: capRunId, signal: "hook-context-limit" }),
              threadId,
              runId: capRunId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "completed",
              title: "Automatic continuation paused",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "system_notice",
              level: "warning",
              message: "Context limit reached.",
            },
          ],
        });
      if (["fork", "subagent", "side-chat", "successor"].includes(scenario)) {
        records = {
          ...records,
          thread: {
            ...records.thread,
            ...(scenario === "successor" ? { handoffSourceThreadId: sourceId } : {}),
            lineage: {
              ...records.thread.lineage,
              parentThreadId: scenario === "successor" ? null : sourceId,
              relationshipToParent:
                scenario === "subagent" ? "subagent" : scenario === "successor" ? null : "fork",
              ...(scenario === "side-chat" ? { sideChat: true } : {}),
            },
          },
        };
      }
      if (scenario === "metadata")
        records = { ...records, thread: { ...records.thread, branch: "thread-metadata" } };
      if (scenario === "dirty" || scenario === "checkpoint" || scenario === "checkpoint-timeout")
        yield* fixture.write("file.txt", "b\n");
      if (scenario === "checkpoint" || scenario === "checkpoint-timeout")
        records = {
          ...records,
          checkpoints: [
            {
              id: "cp",
              threadId: sourceId,
              scopeId: "scope",
              runId: null,
              nodeId: "node",
              parentCheckpointId: null,
              ordinalWithinScope: 1,
              appRunOrdinal: null,
              ref: "refs/checkpoints/fixture",
              status: "ready",
              files: [],
              capturedAt: now,
            } as never,
          ],
        };
      const run = yield* decodeRun({
        id: "queued-run",
        threadId,
        ordinal: 1,
        providerInstanceId: "codex",
        modelSelection: selection,
        providerThreadId: null,
        userMessageId: "message",
        rootNodeId: null,
        activeAttemptId: null,
        status: "queued",
        requestedAt: now,
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      });
      if (
        [
          "cap-reconciled",
          "unborn",
          "non-repo",
          "oversized",
          "checkpoint-timeout",
          "untracked-timeout",
          "unborn-checkpoint-change",
          "settled-stale",
          "newer-run",
          "rewrite-run",
        ].includes(scenario)
      )
        records = {
          ...records,
          runs: [{ ...run, id: capRunId, status: "completed", startedAt: now, completedAt: now }],
        };
      if (scenario === "unborn")
        yield* (yield* FileSystem.FileSystem).remove(fixture.cwd + "/.git/refs/heads/physical");
      if (scenario === "non-repo")
        yield* (yield* FileSystem.FileSystem).remove(fixture.cwd + "/.git", { recursive: true });
      if (scenario === "settled-stale")
        records = { ...records, thread: { ...records.thread, settledOverride: "settled" } };
      if (scenario === "newer-run")
        records = {
          ...records,
          runs: [
            ...records.runs,
            {
              ...run,
              id: RunId.make("newer"),
              ordinal: 2,
              status: "completed",
              startedAt: DateTime.makeUnsafe("2099-01-01T00:00:00Z"),
              completedAt: DateTime.makeUnsafe("2099-01-01T00:00:00Z"),
            },
          ],
        };
      if (scenario === "rewrite-run")
        records = {
          ...records,
          runs: [
            ...records.runs.map((existing) => ({ ...existing, status: "failed" as const })),
            {
              ...run,
              id: RunId.make("report-rewrite"),
              ordinal: 2,
              status: "completed",
              hookContinuationOfRunId: capRunId,
              startedAt: DateTime.makeUnsafe("2099-01-01T00:00:00Z"),
              completedAt: DateTime.makeUnsafe("2099-01-01T00:00:00Z"),
            },
          ],
        };
      if (scenario === "chain-ready" || scenario === "chain-pending") {
        records = decodeRecords({
          ...records,
          thread: { ...records.thread, handoffSourceThreadId: sourceId },
          providerThreads: records.providerThreads.map((provider) => ({
            ...provider,
            nativeThreadRef: { driver: "codex", nativeId: "own-native", strength: "strong" },
          })),
          runs: [{ ...run, id: capRunId, status: "completed", startedAt: now, completedAt: now }],
          attempts: [
            {
              id: "own-attempt",
              nativeThreadId: "own-native",
              runId: capRunId,
              attemptOrdinal: 1,
              rootNodeId: "own-node",
              providerInstanceId: "codex",
              providerThreadId: "provider-thread",
              providerTurnId: "own-turn",
              reason: "initial",
              status: "completed",
              startedAt: now,
              completedAt: now,
            },
          ],
          providerTurns: [
            {
              id: "own-turn",
              providerThreadId: "provider-thread",
              nodeId: "own-node",
              runAttemptId: "own-attempt",
              nativeTurnRef: null,
              ordinal: 1,
              status: "completed",
              startedAt: now,
              completedAt: now,
              tokenUsage: { usedTokens: 250_000, updatedAt: DateTime.formatIso(now) },
            },
          ],
        });
      }
      if (scenario === "queued" || scenario === "contradictory")
        records = { ...records, runs: [run] };
      if (scenario === "approval")
        records = {
          ...records,
          runtimeRequests: [
            yield* decodeRequest({
              id: "approval",
              nodeId: "node",
              providerTurnId: null,
              nativeRequestRef: null,
              kind: "command",
              status: "pending",
              responseCapability: { type: "message" },
              createdAt: now,
              resolvedAt: null,
            }),
          ],
        };
      const outbox = yield* Outbox.EffectOutboxV2;
      const request = {
        type: "thread.handoff",
        handoff: {
          goal: "Finish",
          decisions: [],
          state: { branch: "physical", commits: [], verified: [] },
          deadEnds: [],
          next: "Review",
          pointers: [],
          ...([
            "unborn",
            "non-repo",
            "oversized",
            "settled-stale",
            "newer-run",
            "rewrite-run",
            "checkpoint-timeout",
            "untracked-timeout",
            "unborn-checkpoint-change",
          ].includes(scenario) ||
          scenario === "cap-reconciled" ||
          scenario === "cap-run-missing"
            ? { contextLimitWork: { capRunId, results: [] } }
            : {}),
        },
        projectId: records.thread.projectId,
        sourceThreadId: threadId,
        successorThreadId: ThreadId.make("reserved-only"),
        modelSelection: records.thread.modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        worktreePath: fixture.cwd,
        branch: "physical",
      } satisfies HandoffRequest;
      yield* TestClock.setTime(DateTime.toEpochMillis(now));
      yield* outbox.enqueue([
        {
          id: handoffId(threadId),
          commandId: CommandId.make(handoffId(threadId)),
          threadId,
          request,
        },
      ]);
      const beforeRow = yield* outbox.get(handoffId(threadId));
      const sql = yield* SqlClient.SqlClient;
      const successorCount =
        yield* sql`SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads`;

      const readRecords: Threads.ThreadManagementService["Service"]["readHandoffRecords"] = (id) =>
        Effect.sync(() => {
          reads++;
          if (id === sourceId && (scenario === "chain-ready" || scenario === "chain-pending"))
            return decodeRecords({
              ...recordsFor(fixture.cwd),
              thread: {
                ...recordsFor(fixture.cwd).thread,
                handoffTransfer: {
                  requestId: "predecessor-request",
                  generation: "generation",
                  sourceThreadId: sourceId,
                  successorThreadId: threadId,
                  runId: capRunId,
                  state: scenario === "chain-ready" ? "started" : "released",
                },
              },
            }) as never;
          if (scenario === "read-error") throw new Error("fixture read failure");
          if (id === childId)
            return {
              ...recordsFor(fixture.cwd, childId),
              runs: scenario === "active-child" ? [run] : [],
            } as never;
          if (scenario === "missing-array") return { ...records, runs: undefined } as never;
          if (scenario === "unborn-checkpoint-change")
            return {
              ...records,
              checkpoints:
                reads > 1
                  ? [
                      {
                        id: "failed-cp",
                        threadId,
                        scopeId: "scope",
                        runId: null,
                        nodeId: "node",
                        parentCheckpointId: null,
                        ordinalWithinScope: 1,
                        appRunOrdinal: null,
                        ref: "refs/failed",
                        status: "error",
                        files: [],
                        capturedAt: now,
                      },
                    ]
                  : [],
            } as never;
          return scenario === "run-change" && reads > 1
            ? ({ ...records, runs: [run] } as never)
            : (records as never);
        });
      let observedSequence = 1;
      const observe = (expected = "older-generation") =>
        queryHandoffReadiness(threadId, expected).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(Threads.ThreadManagementService)({
                readHandoffRecords: readRecords,
                getThreadEventSequence: () =>
                  Effect.sync(
                    () => ++sequences && (scenario === "run-change" ? sequences : observedSequence),
                  ),
                readHandoffChildIds: () =>
                  Effect.sync(() => {
                    indexReads++;
                    if (scenario === "index-error") throw new Error("index unavailable");
                    if (scenario === "child-array-missing") return undefined as never;
                    return scenario === "active-child" ||
                      (scenario === "child-change" && indexReads > 1)
                      ? [childId]
                      : [];
                  }),
              }),
              Layer.mock(Projects.ProjectStoreV2)({}),
              Layer.mock(Git.GitManager)({
                observeHandoffWorkspace: Effect.fnUntraced(function* (cwd, ref) {
                  const result = yield* Git.observeHandoffWorkspace(
                    [
                      "oversized",
                      "checkpoint-timeout",
                      "untracked-timeout",
                      "unborn-checkpoint-change",
                    ].includes(scenario)
                      ? {
                          execute: (input) =>
                            (scenario === "checkpoint-timeout" &&
                              input.args[2]?.includes("refs/checkpoints")) ||
                            (scenario === "untracked-timeout" && input.args[0] === "ls-files") ||
                            (scenario === "unborn-checkpoint-change" &&
                              input.args[0] === "rev-parse" &&
                              input.args[2] === "HEAD")
                              ? Effect.fail(
                                  new GitCommandError({
                                    operation: "observe",
                                    command: "git",
                                    cwd,
                                    detail: "Git command timed out",
                                  }),
                                )
                              : scenario === "oversized" && input.args[0] === "status"
                                ? Effect.succeed({
                                    exitCode: 0,
                                    stdout: "",
                                    stderr: "",
                                    stdoutTruncated: true,
                                    stderrTruncated: false,
                                  } as never)
                                : driver.execute(input),
                        }
                      : driver,
                    cwd,
                    ref,
                  );
                  if (scenario === "head-change" && reads === 1)
                    yield* fixture
                      .write(".git/refs/heads/physical", fixture.checkpoint + "\n")
                      .pipe(Effect.orDie);
                  return result;
                }),
              }),
              Layer.mock(Sessions.ProviderSessionManagerV2)({
                observeHandoffSession: () =>
                  scenario === "provider-missing"
                    ? Effect.succeedNone
                    : Effect.succeedSome({
                        idleGeneration: 7,
                        busyTurns: [],
                        runtime: {
                          providerSessionId: "session",
                          instanceId: selection.instanceId,
                          driver: "codex",
                          handoffReadinessCoverage:
                            [
                              "unborn",
                              "non-repo",
                              "oversized",
                              "checkpoint-timeout",
                              "untracked-timeout",
                              "unborn-checkpoint-change",
                            ].includes(scenario) ||
                            scenario === "non-context-handoff" ||
                            scenario === "cap-reconciled" ||
                            scenario === "rewrite-run" ||
                            scenario === "cap-run-missing"
                              ? {
                                  scope: "all-app-owned-work",
                                  nativeSubagents: true,
                                  detachedTasks: true,
                                }
                              : undefined,
                          hasPendingBackgroundWork:
                            scenario === "probe-missing" || scenario === "contradictory"
                              ? undefined
                              : scenario === "probe-error"
                                ? Effect.die("fixture probe failure")
                                : Effect.succeed(scenario === "jobs"),
                          hasPendingBackgroundWorkForThread: () => Effect.succeed(false),
                        } as never,
                      }),
              }),
              Layer.mock(Terminals.TerminalManager)({
                observeHandoff: () =>
                  scenario === "terminal-array-missing"
                    ? Effect.succeed(undefined as never)
                    : scenario === "terminal-missing"
                      ? Effect.die("fixture terminal failure")
                      : Effect.succeed([]),
              }),
            ),
          ),
        );
      const result = yield* observe();
      assert.isFalse(result.expectedGenerationMatches);
      assert.isFalse(result.transferAuthorized);
      assert.isTrue(result.observationalOnly);
      assert.isTrue(Object.isFrozen(result.before.children));
      assert.deepEqual(yield* outbox.get(handoffId(threadId)), beforeRow);
      assert.deepEqual(
        yield* sql`SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads`,
        successorCount,
      );
      if (
        result.before.sourceRecords !== null &&
        ![
          "unborn",
          "non-repo",
          "oversized",
          "checkpoint-timeout",
          "untracked-timeout",
          "unborn-checkpoint-change",
        ].includes(scenario)
      )
        assert.equal(result.before.workspace?.head, fixture.head);
      if (
        [
          "settled-stale",
          "newer-run",
          "subagent",
          "side-chat",
          "successor",
          "chain-pending",
          "contradictory",
          "cap-missing-proof",
          "metadata",
          "dirty",
          "active-child",
          "jobs",
          "approval",
          "queued",
          "run-change",
          "head-change",
        ].includes(scenario)
      )
        assert.equal(result.classification, "known_blocked");
      else if (
        [
          "provider-missing",
          "probe-missing",
          "probe-error",
          "terminal-array-missing",
          "child-array-missing",
          "terminal-missing",
          "read-error",
          "missing-array",
          "index-error",
          "head-change",
          "child-change",
        ].includes(scenario)
      )
        assert.equal(result.classification, "unknown");
      else
        assert.equal(
          result.classification,
          [
            "cap-reconciled",
            "rewrite-run",
            "unborn",
            "non-repo",
            "oversized",
            "checkpoint-timeout",
            "untracked-timeout",
            "unborn-checkpoint-change",
          ].includes(scenario)
            ? "automatically_eligible"
            : "manual_review",
          result.after.blockers.join(" | "),
        );
      if (["head-change", "run-change", "child-change"].includes(scenario))
        assert.isFalse(result.stable);
      if (scenario === "cap-run-missing")
        assert.include(
          result.after.manualReview,
          "The context-limit run's completion could not be confirmed.",
        );
      if (scenario === "checkpoint") {
        assert.isTrue(result.before.workspace?.checkpointMatches);
        assert.equal(result.before.workspace?.checkpointCommit, fixture.checkpoint);
      }
      if (scenario === "contradictory") {
        assert.isNotEmpty(result.before.blockers);
        assert.isNotEmpty(result.before.unknowns);
      }
      assert.match(result.generation, /^[a-f0-9]{64}$/);
      const large = {
        ...result,
        before: {
          ...result.before,
          request: "PRIVATE_HISTORY".repeat(100_000),
          blockers: Array.from({ length: 1000 }, (_, index) => `${index}:` + "\u0000".repeat(200)),
          workspace: result.before.workspace && {
            ...result.before.workspace,
            indexDiff: "BINARY_DIFF".repeat(100_000),
          },
        },
      };
      const summary = summarizeHandoffReadiness(large);
      assert.isBelow(Buffer.byteLength(JSON.stringify(summary), "utf8"), 8192);
      assert.notInclude(JSON.stringify(summary), "PRIVATE_HISTORY");
      assert.notInclude(JSON.stringify(summary), "BINARY_DIFF");
      if (scenario === "cap-reconciled") {
        const repeated = yield* observe(result.generation);
        assert.equal(repeated.generation, result.generation);
        assert.isTrue(repeated.expectedGenerationMatches);
        observedSequence++;
        const changed = yield* observe(result.generation);
        assert.notEqual(changed.generation, result.generation);
        assert.isFalse(changed.expectedGenerationMatches);
        assert.isFalse((yield* observe("different-material-generation")).expectedGenerationMatches);
      }

      // No launch/settle/send service is provided: query cannot create executable work.
    }),
  );
});
