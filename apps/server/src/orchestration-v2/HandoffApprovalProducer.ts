import { CommandId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Settings from "../serverSettings.ts";
import { ProviderTurnStartModels } from "./ProviderTurnStartService.ts";
import { usageLimitFailoverIntent } from "./UsageLimitFailoverPolicy.ts";
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
import { withAutomaticHandoffAuthority } from "./AutomaticHandoffAuthority.ts";
const isHandoffParked = Schema.is(HandoffParked);

export class HandoffApprovalProducer extends Context.Service<
  HandoffApprovalProducer,
  {
    readonly requestIfReady: (
      sourceId: ThreadId,
    ) => Effect.Effect<"accepted" | void, HandoffParked>;
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
  const settings = yield* Effect.serviceOption(Settings.ServerSettingsService);
  const models = yield* ProviderTurnStartModels;
  const requestIfReady = Effect.fn("HandoffApprovalProducer.requestIfReady")(
    function* (sourceId: ThreadId) {
      const parked = yield* outbox.get(`core-handoff:${sourceId}`);
      const records = yield* threads.getThreadRecords(sourceId, ["runtimeRequests"]);
      if (
        records.thread.handoffStopCommandId !== undefined ||
        records.thread.handoffTransfer !== undefined ||
        records.runtimeRequests.some(
          (request) =>
            request.responseCapability.type === "handoff" &&
            (Option.isNone(parked) ||
              DateTime.toEpochMillis(request.createdAt) >= Date.parse(parked.value.createdAt)),
        )
      )
        return;
      if (Option.isNone(git) || Option.isNone(terminals))
        return yield* new HandoffParked({
          message: "Physical readiness owners unavailable; request remains parked.",
          category: "unknown",
        });
      if (
        Option.isSome(parked) &&
        parked.value.request.type === "thread.handoff" &&
        parked.value.request.intent === undefined &&
        Option.isSome(settings)
      ) {
        const preferences = yield* settings.value.getSettings;
        if (preferences.rootOwnerUsageLimitFailover?.enabled) {
          const source = yield* threads.getThreadRecords(sourceId, [
            "runs",
            "turnItems",
            "checkpoints",
          ]);
          const intent = usageLimitFailoverIntent(
            source,
            parked.value.request,
            preferences,
            yield* models.getProviders,
            DateTime.toEpochMillis(yield* DateTime.now),
          );
          if (intent !== null)
            yield* outbox.bindUsageLimitIntent(parked.value, {
              ...parked.value.request,
              intent,
              modelSelection: intent.destinationSelection,
            });
        }
      }
      const successor = yield* threads.getThreadShell(
        ThreadId.make(`core-handoff:${sourceId}:successor`),
      );
      if (successor !== null) return;
      return yield* Effect.gen(function* () {
        const observed = yield* queryHandoffReadiness(sourceId);
        if (
          !observed.stable ||
          (observed.classification !== "manual_review" &&
            observed.classification !== "automatically_eligible")
        )
          return yield* new HandoffParked({
            message:
              observed.after.blockers[0] ??
              observed.after.unknowns[0] ??
              observed.after.manualReview[0] ??
              "Readiness observation changed",
            category: observed.after.blockers.length ? "blocked" : "unknown",
            generation: observed.generation,
          });
        if (observed.classification === "manual_review") {
          yield* requestHandoffApproval(sourceId, observed.generation);
          return;
        }
        const review = yield* requestHandoffApproval(sourceId, observed.generation, "automatic");
        yield* withAutomaticHandoffAuthority(
          { threadId: sourceId, requestId: review.requestId, generation: review.generation },
          threads.dispatch({
            type: "runtime-request.respond",
            commandId: CommandId.make(`${review.requestId}:automatic-accept`),
            threadId: sourceId,
            requestId: review.requestId,
            decision: "accept",
            handoffGeneration: review.generation,
          }),
        );
        return "accepted" as const;
      }).pipe(
        Effect.provideService(Threads.ThreadManagementService, threads),
        Effect.provideService(Projects.ProjectStoreV2, projects),
        Effect.provideService(Sessions.ProviderSessionManagerV2, sessions),
        Effect.provideService(Outbox.EffectOutboxV2, outbox),
        Effect.provideService(Digest.Digest, digest),
        Effect.provideService(ProviderTurnStartModels, models),
        (effect) =>
          Option.isSome(settings)
            ? Effect.provideService(effect, Settings.ServerSettingsService, settings.value)
            : effect,
        Effect.provideService(Git.GitManager, git.value),
        Effect.provideService(Terminals.TerminalManager, terminals.value),
      );
    },
    Effect.mapError((cause) =>
      isHandoffParked(cause)
        ? cause
        : new HandoffParked({
            message: "Review observation changed or was unavailable; request remains parked.",
            category: "unknown",
          }),
    ),
  );
  return HandoffApprovalProducer.of({ requestIfReady });
});
export const layer = Layer.effect(HandoffApprovalProducer, make);
