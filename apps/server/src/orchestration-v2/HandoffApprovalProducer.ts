import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Digest from "effect/crypto/Digest";
import * as Git from "../git/GitManager.ts";
import * as Terminals from "../terminal/Manager.ts";
import * as Projects from "./ProjectStore.ts";
import * as Sessions from "./ProviderSessionManager.ts";
import * as Outbox from "./EffectOutbox.ts";
import * as Threads from "./ThreadManagementService.ts";
import { HandoffParked } from "./CoreHandoff.ts";
import { queryHandoffReadiness } from "./CoreHandoffReadiness.ts";
import { requestHandoffApproval } from "./HandoffApproval.ts";

export class HandoffApprovalProducer extends Context.Service<
  HandoffApprovalProducer,
  {
    readonly requestIfReady: (sourceId: ThreadId) => Effect.Effect<void, HandoffParked>;
  }
>()("t3/orchestration-v2/HandoffApprovalProducer") {}

const make = Effect.gen(function* () {
  const threads = yield* Threads.ThreadManagementService;
  const projects = yield* Projects.ProjectStoreV2;
  const sessions = yield* Sessions.ProviderSessionManagerV2;
  const outbox = yield* Outbox.EffectOutboxV2;
  const digest = yield* Digest.Digest;
  const git = yield* Effect.serviceOption(Git.GitManager);
  const terminals = yield* Effect.serviceOption(Terminals.TerminalManager);
  const requestIfReady = Effect.fn("HandoffApprovalProducer.requestIfReady")(
    function* (sourceId: ThreadId) {
      const records = yield* threads.getThreadRecords(sourceId, ["runtimeRequests"]);
      if (
        records.thread.handoffStopCommandId !== undefined ||
        records.thread.handoffTransfer !== undefined ||
        records.runtimeRequests.some((request) => request.responseCapability.type === "handoff")
      )
        return;
      if (Option.isNone(git) || Option.isNone(terminals))
        return yield* new HandoffParked({
          message: "Physical readiness owners unavailable; request remains parked.",
        });
      const successor = yield* threads.getThreadShell(
        ThreadId.make(`core-handoff:${sourceId}:successor`),
      );
      if (successor !== null) return;
      yield* Effect.gen(function* () {
        const observed = yield* queryHandoffReadiness(sourceId);
        if (!observed.stable || observed.classification !== "manual_review")
          return yield* new HandoffParked({
            message: "Source is not ready for bounded manual review; request remains parked.",
          });
        yield* requestHandoffApproval(sourceId, observed.generation);
      }).pipe(
        Effect.provideService(Threads.ThreadManagementService, threads),
        Effect.provideService(Projects.ProjectStoreV2, projects),
        Effect.provideService(Sessions.ProviderSessionManagerV2, sessions),
        Effect.provideService(Outbox.EffectOutboxV2, outbox),
        Effect.provideService(Digest.Digest, digest),
        Effect.provideService(Git.GitManager, git.value),
        Effect.provideService(Terminals.TerminalManager, terminals.value),
      );
    },
    Effect.mapError(
      () =>
        new HandoffParked({
          message: "Review observation changed or was unavailable; request remains parked.",
        }),
    ),
  );
  return HandoffApprovalProducer.of({ requestIfReady });
});
export const layer = Layer.effect(HandoffApprovalProducer, make);
