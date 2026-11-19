import { assert, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  RunId,
  ThreadId,
  ProviderInstanceId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { continueHookRun } from "./HookContinuation.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

it.effect("dispatches one replay-safe continuation and carries its staged workspace", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("hook-test-thread");
    const sourceRunId = RunId.make("hook-test-run");
    const messageId = MessageId.make(`message:hook-continuation:${sourceRunId}`);
    const originalId = MessageId.make("hook-original-message");
    let delivered = false;
    const commands: Parameters<
      ThreadManagementService.ThreadManagementService["Service"]["dispatch"]
    >[0][] = [];
    const projection = {
      runs: [
        {
          id: sourceRunId,
          threadId,
          status: "completed",
          userMessageId: originalId,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" },
        },
      ],
      messages: [{ id: originalId, text: "Please build this." }],
    } as unknown as OrchestrationV2ThreadProjection;
    const layer = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadRecords: (_thread, _fields, filter) =>
        Effect.succeed({
          ...projection,
          runs:
            filter?.runIds === undefined
              ? []
              : projection.runs.filter((run) => filter.runIds!.includes(run.id)),
          messages: filter?.messageIds?.includes(originalId)
            ? projection.messages
            : delivered && filter?.messageIds?.includes(messageId)
              ? [{ id: messageId } as never]
              : [],
        }),
      dispatch: (command) => {
        commands.push(command);
        delivered = true;
        return Effect.succeed({} as never);
      },
    });
    const input = {
      threadId,
      sourceRunId,
      stageWorkspaceRoot: "C:/workspace",
      messages: ["The first step is still executable. Read AGENTS.md."],
    };
    yield* continueHookRun(input).pipe(Effect.provide(layer));
    yield* continueHookRun(input).pipe(Effect.provide(layer));
    assert.lengthOf(commands, 1);
    const command = commands[0]!;
    assert.equal(command.type, "message.dispatch");
    if (command.type === "message.dispatch") {
      assert.equal(command.hookContinuationOfRunId, sourceRunId);
      assert.equal(command.hookStageWorkspaceRoot, "C:/workspace");
      assert.include(command.text, "The first step is still executable. Read AGENTS.md.");
      assert.equal(command.creationSource, "server");
      assert.equal(command.modelSelection?.model, "gpt-6");
    }
  }),
);

it.effect("continues staged preparation under Full Stop", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("hook-stop-thread");
    const sourceRunId = RunId.make("hook-stop-run");
    const originalId = MessageId.make("hook-stop-original");
    let dispatches = 0;
    let stagedRoot: string | undefined;
    const projection = {
      runs: [{ id: sourceRunId, threadId, status: "completed", userMessageId: originalId }],
      messages: [{ id: originalId, text: "Full Stop: prepare only." }],
    } as unknown as OrchestrationV2ThreadProjection;
    yield* continueHookRun({ threadId, sourceRunId, stageWorkspaceRoot: "C:/staging" }).pipe(
      Effect.provide(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (_thread, _fields, filter) =>
            Effect.succeed({
              ...projection,
              messages: filter?.messageIds?.includes(originalId) ? projection.messages : [],
            }),
          dispatch: (command) => {
            dispatches++;
            if (command.type === "message.dispatch") stagedRoot = command.hookStageWorkspaceRoot;
            return Effect.succeed({} as never);
          },
        }),
      ),
    );
    assert.equal(dispatches, 1);
    assert.equal(stagedRoot, "C:/staging");
  }),
);

it.effect("does not continue after an explicit user Stop", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("hook-explicit-stop-thread");
    const sourceRunId = RunId.make("hook-explicit-stop-run");
    const originalId = MessageId.make("hook-explicit-stop-original");
    let dispatches = 0;
    const projection = {
      runs: [{ id: sourceRunId, threadId, status: "completed", userMessageId: originalId }],
      messages: [{ id: originalId, text: "Stop. Wait for me." }],
    } as unknown as OrchestrationV2ThreadProjection;
    yield* continueHookRun({ threadId, sourceRunId }).pipe(
      Effect.provide(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (_thread, _fields, filter) =>
            Effect.succeed({
              ...projection,
              messages: filter?.messageIds?.includes(originalId) ? projection.messages : [],
            }),
          dispatch: () => {
            dispatches++;
            return Effect.succeed({} as never);
          },
        }),
      ),
    );
    assert.equal(dispatches, 0);
  }),
);

it.effect("does not let a later wait suppress the first requested work", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("hook-compound-wait-thread");
    const sourceRunId = RunId.make("hook-compound-wait-run");
    const originalId = MessageId.make("hook-compound-wait-original");
    let dispatches = 0;
    const projection = {
      runs: [{ id: sourceRunId, threadId, status: "completed", userMessageId: originalId }],
      messages: [{ id: originalId, text: "Work on X, then wait for Y." }],
    } as unknown as OrchestrationV2ThreadProjection;
    yield* continueHookRun({ threadId, sourceRunId }).pipe(
      Effect.provide(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (_thread, _fields, filter) =>
            Effect.succeed({
              ...projection,
              messages: filter?.messageIds?.includes(originalId) ? projection.messages : [],
            }),
          dispatch: () => {
            dispatches++;
            return Effect.succeed({} as never);
          },
        }),
      ),
    );
    assert.equal(dispatches, 1);
  }),
);

it.effect("stops an automatic continuation chain after two attempts", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("hook-loop-thread");
    const ids = [0, 1, 2, 3].map((index) => RunId.make(`hook-loop-${index}`));
    const runs = ids.map((id, index) => ({
      id,
      threadId,
      status: "completed",
      userMessageId: MessageId.make(`hook-loop-message-${index}`),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" },
      ...(index === 0 ? {} : { hookContinuationOfRunId: ids[index - 1] }),
    })) as unknown as OrchestrationV2ThreadProjection["runs"];
    const lookups: RunId[] = [];
    let dispatches = 0;
    yield* continueHookRun({ threadId, sourceRunId: ids[3]! }).pipe(
      Effect.provide(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (_thread, _fields, filter) => {
            if (filter?.runIds) lookups.push(...filter.runIds);
            return Effect.succeed({
              runs:
                filter?.runIds === undefined
                  ? []
                  : runs.filter((run) => filter.runIds!.includes(run.id)),
              messages: [],
            } as unknown as OrchestrationV2ThreadProjection);
          },
          dispatch: () => {
            dispatches++;
            return Effect.succeed({} as never);
          },
        }),
      ),
    );
    assert.equal(dispatches, 0);
    assert.deepEqual(lookups, [ids[3], ids[2], ids[1]]);
  }),
);

it.effect("walks consecutive continuation parents through filtered projection reads", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("hook-consecutive-thread");
    const ids = ["root", "first", "second"].map((id) => RunId.make(`hook-${id}`));
    const originalId = MessageId.make("hook-consecutive-original");
    const runs = ids.map((id, index) => ({
      id,
      threadId,
      status: "completed",
      userMessageId: originalId,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" },
      ...(index === 0 ? {} : { hookContinuationOfRunId: ids[index - 1] }),
    })) as unknown as OrchestrationV2ThreadProjection["runs"];
    const runLookups: RunId[] = [];
    const dispatched: RunId[] = [];
    const layer = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadRecords: (_thread, _fields, filter) => {
        if (filter?.runIds) runLookups.push(...filter.runIds);
        return Effect.succeed({
          runs:
            filter?.runIds === undefined
              ? []
              : runs.filter((run) => filter.runIds!.includes(run.id)),
          messages: filter?.messageIds?.includes(originalId)
            ? [{ id: originalId, text: "Please build this." } as never]
            : [],
        } as unknown as OrchestrationV2ThreadProjection);
      },
      dispatch: (command) => {
        if (command.type === "message.dispatch") dispatched.push(command.hookContinuationOfRunId!);
        return Effect.succeed({} as never);
      },
    });

    yield* continueHookRun({ threadId, sourceRunId: ids[1]! }).pipe(Effect.provide(layer));
    yield* continueHookRun({ threadId, sourceRunId: ids[2]! }).pipe(Effect.provide(layer));

    assert.deepEqual(dispatched, [ids[1]]);
    assert.deepEqual(runLookups, [ids[1], ids[0], ids[2], ids[1], ids[0]]);
  }),
);

it.effect("does not continue when a parent run is missing or cyclic", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("hook-invalid-chain-thread");
    const makeRun = (id: RunId, parent?: RunId) => ({
      id,
      threadId,
      status: "completed",
      userMessageId: MessageId.make(`message:${id}`),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" },
      ...(parent === undefined ? {} : { hookContinuationOfRunId: parent }),
    });
    const chains = [
      {
        source: RunId.make("hook-missing-source"),
        runs: [makeRun(RunId.make("hook-missing-source"), RunId.make("hook-missing-parent"))],
      },
      {
        source: RunId.make("hook-cycle-a"),
        runs: [
          makeRun(RunId.make("hook-cycle-a"), RunId.make("hook-cycle-b")),
          makeRun(RunId.make("hook-cycle-b"), RunId.make("hook-cycle-a")),
        ],
      },
    ];
    for (const chain of chains) {
      let dispatches = 0;
      yield* continueHookRun({ threadId, sourceRunId: chain.source }).pipe(
        Effect.provide(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: (_thread, _fields, filter) =>
              Effect.succeed({
                runs:
                  filter?.runIds === undefined
                    ? []
                    : chain.runs.filter((run) => filter.runIds!.includes(run.id)),
                messages: [],
              } as unknown as OrchestrationV2ThreadProjection),
            dispatch: () => {
              dispatches++;
              return Effect.succeed({} as never);
            },
          }),
        ),
      );
      assert.equal(dispatches, 0);
    }
  }),
);

it.effect("steers a hook-blocked report with the hook rule and correction", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("hook-correction-thread");
    const sourceRunId = RunId.make("hook-correction-run");
    const originalId = MessageId.make("hook-correction-original");
    const rootNodeId = NodeId.make("hook-correction-root");
    const commands: Parameters<
      ThreadManagementService.ThreadManagementService["Service"]["dispatch"]
    >[0][] = [];
    const projection = {
      runs: [
        {
          id: sourceRunId,
          threadId,
          status: "failed",
          userMessageId: originalId,
          rootNodeId,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" },
        },
      ],
      messages: [{ id: originalId, text: "Write a report for me." }],
      turnItems: [
        {
          type: "assistant_message",
          status: "completed",
          runId: sourceRunId,
          nodeId: rootNodeId,
          text: "**What happened**\n- Done: existing hold acknowledged.\n\n**Next steps in order**\n1. [Thread: Worker Coordinator; ref=<t3-thread://v2/local/worker-coordinator>]: Continue the hold inventory.\n2. Maxi: release only after update.",
        },
        {
          type: "error",
          status: "failed",
          runId: sourceRunId,
          nodeId: rootNodeId,
          failure: {
            code: "hook_blocked",
            message: "Use both required headings and include the missing correction.",
          },
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const layer = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadRecords: () => Effect.succeed(projection),
      dispatch: (command) => {
        commands.push(command);
        return Effect.succeed({} as never);
      },
    });

    yield* continueHookRun({
      threadId,
      sourceRunId,
      messages: ["Use both required headings", "include the missing correction"],
    }).pipe(Effect.provide(layer));

    assert.lengthOf(commands, 1);
    const command = commands[0]!;
    assert.equal(command.type, "message.dispatch");
    if (command.type === "message.dispatch") {
      assert.include(command.text, "Use both required headings");
      assert.include(command.text, "include the missing correction");
      assert.include(command.text, "Correct it to follow the hook's rule");
      assert.include(command.text, "What went wrong:");
      assert.include(command.text, "Read the applicable AGENTS.md and fix the output");
      assert.include(command.text, "Rewrite only that reply");
      assert.notInclude(command.text, "Codex:");
      assert.notInclude(command.text, "Your first next step is assigned to you");
      assert.equal(command.hookContinuationOfRunId, sourceRunId);
    }
  }),
);

const chainLayer = (
  threadId: ThreadId,
  runs: ReadonlyArray<Record<string, unknown>>,
  dispatched: Array<RunId>,
) =>
  Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadRecords: (_thread, _fields, filter) =>
      Effect.succeed({
        runs:
          filter?.runIds === undefined
            ? []
            : runs.filter((run) => filter.runIds!.includes(run.id as RunId)),
        messages: filter?.messageIds?.includes(MessageId.make(`${threadId}:original`))
          ? [{ id: MessageId.make(`${threadId}:original`), text: "Please build this." }]
          : [],
        turnItems: runs
          .filter((run) => run.status === "failed")
          .map((run) => ({
            type: "error",
            status: "failed",
            runId: run.id,
            nodeId: run.rootNodeId,
            failure: { code: "hook_blocked", message: "Keep it short." },
          })),
      } as unknown as OrchestrationV2ThreadProjection),
    dispatch: (command) => {
      if (command.type === "message.dispatch") dispatched.push(command.hookContinuationOfRunId!);
      return Effect.succeed({} as never);
    },
  });

const chainRun = (
  threadId: ThreadId,
  id: string,
  status: "completed" | "failed",
  parent?: string,
) => ({
  id: RunId.make(id),
  threadId,
  status,
  rootNodeId: NodeId.make(`${id}:root`),
  startedAt: DateTime.makeUnsafe("2026-11-19T21:00:00.000Z"),
  userMessageId: MessageId.make(parent === undefined ? `${threadId}:original` : `${id}:message`),
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" },
  ...(parent === undefined ? {} : { hookContinuationOfRunId: RunId.make(parent) }),
});

it.effect("rewrites each blocked report once but rewrites again after resumed work", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("hook-rewrite-chain");
    const runs = [
      chainRun(threadId, "blocked", "failed"),
      chainRun(threadId, "rewrite", "failed", "blocked"),
      chainRun(threadId, "rewrite-ok", "completed", "blocked"),
      chainRun(threadId, "resumed", "failed", "rewrite-ok"),
    ];
    const dispatched: Array<RunId> = [];
    const layer = chainLayer(threadId, runs, dispatched);
    const repair = { maxAttempts: 1, deadlineSeconds: 120 };
    yield* continueHookRun({ threadId, sourceRunId: RunId.make("blocked"), repair }).pipe(
      Effect.provide(layer),
    );
    yield* continueHookRun({ threadId, sourceRunId: RunId.make("rewrite"), repair }).pipe(
      Effect.provide(layer),
    );
    yield* continueHookRun({ threadId, sourceRunId: RunId.make("resumed"), repair }).pipe(
      Effect.provide(layer),
    );
    assert.deepEqual(dispatched, [RunId.make("blocked"), RunId.make("resumed")]);
  }),
);

it.effect("does not resume work while this chain's handoff waits for its successor", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("hook-handoff-chain");
    const runs = [
      chainRun(threadId, "blocked-report", "failed"),
      chainRun(threadId, "rewritten-report", "completed", "blocked-report"),
    ];
    const outbox = (createdAt: string) =>
      Layer.mock(EffectOutbox.EffectOutboxV2)({
        get: (id) =>
          Effect.succeed(
            id === `core-handoff:${threadId}`
              ? Option.some({ status: "failed", createdAt } as never)
              : Option.none(),
          ),
      });
    for (const [createdAt, expected] of [
      ["2026-11-19T21:01:00.000Z", 0],
      ["2026-11-19T20:00:00.000Z", 1],
    ] as const) {
      const dispatched: Array<RunId> = [];
      yield* continueHookRun({ threadId, sourceRunId: RunId.make("rewritten-report") }).pipe(
        Effect.provide(Layer.merge(chainLayer(threadId, runs, dispatched), outbox(createdAt))),
      );
      assert.lengthOf(dispatched, expected);
    }
  }),
);
