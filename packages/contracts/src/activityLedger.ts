import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const ActivityEventKind = Schema.Literals([
  "planned",
  "dispatched",
  "progress",
  "decision",
  "done",
  "blocked",
  "needs_you",
  "handoff",
  "settled",
]);
export type ActivityEventKind = typeof ActivityEventKind.Type;

const ACTIVITY_SUMMARY_MAX_CHARS = 400;
const ACTIVITY_SUMMARY_MAX_LINES = 3;

export const ActivitySummary = TrimmedNonEmptyString.check(
  Schema.isMaxLength(ACTIVITY_SUMMARY_MAX_CHARS),
  Schema.makeFilter(
    (value: string) => value.split(/\r\n|\r|\n/).length <= ACTIVITY_SUMMARY_MAX_LINES,
    { expected: `at most ${ACTIVITY_SUMMARY_MAX_LINES} lines` },
  ),
);

export const ActivityFeatureKey = TrimmedNonEmptyString.check(Schema.isMaxLength(120));
const ActivityUrl = TrimmedNonEmptyString.check(Schema.isMaxLength(2048));
export const ActivityCommits = Schema.Array(
  TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
).check(Schema.isMaxLength(20));

export const ActivityLinks = Schema.Struct({
  sourceThreadId: Schema.optional(ThreadId),
  successorThreadId: Schema.optional(ThreadId),
  commits: Schema.optional(ActivityCommits),
  prUrl: Schema.optional(ActivityUrl),
  notionUrl: Schema.optional(ActivityUrl),
});
export type ActivityLinks = typeof ActivityLinks.Type;

export const ActivityTests = Schema.Struct({
  ran: TrimmedNonEmptyString.check(Schema.isMaxLength(300)),
  result: Schema.Literals(["passed", "failed", "not_run"]),
});
export type ActivityTests = typeof ActivityTests.Type;

export const ActivityNext = TrimmedNonEmptyString.check(Schema.isMaxLength(200));

const activityEventBody = {
  kind: ActivityEventKind,
  projectId: ProjectId,
  threadId: ThreadId,
  featureKey: Schema.optional(ActivityFeatureKey),
  featureTitle: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  summary: ActivitySummary,
  links: Schema.optional(ActivityLinks),
  next: Schema.optional(ActivityNext),
  tests: Schema.optional(ActivityTests),
};

/** What a writer supplies; the ledger assigns id, sequence and time. */
export const ActivityEventDraft = Schema.Struct(activityEventBody);
export type ActivityEventDraft = typeof ActivityEventDraft.Type;

export const ActivityEvent = Schema.Struct({
  /** Monotonic ledger position; clients resume streams after the last one they hold. */
  sequence: NonNegativeInt,
  id: TrimmedNonEmptyString,
  at: IsoDateTime,
  ...activityEventBody,
});
export type ActivityEvent = typeof ActivityEvent.Type;

export const ActivityCheckIn = Schema.Struct({
  seenAt: IsoDateTime,
  seenSequence: NonNegativeInt,
});
export type ActivityCheckIn = typeof ActivityCheckIn.Type;

const ActivityLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }));

export const ActivityListInput = Schema.Struct({
  since: Schema.optional(IsoDateTime),
  afterSequence: Schema.optional(NonNegativeInt),
  projectId: Schema.optional(ProjectId),
  featureKey: Schema.optional(ActivityFeatureKey),
  kinds: Schema.optional(Schema.Array(ActivityEventKind).check(Schema.isMaxLength(9))),
  limit: ActivityLimit,
});
export type ActivityListInput = typeof ActivityListInput.Type;

export const ActivityListResult = Schema.Struct({ events: Schema.Array(ActivityEvent) });
export type ActivityListResult = typeof ActivityListResult.Type;

/** Streams only events appended after `afterSequence` (or after subscribing); never history. */
export const ActivitySubscribeInput = Schema.Struct({
  afterSequence: Schema.optional(NonNegativeInt),
  projectId: Schema.optional(ProjectId),
});
export type ActivitySubscribeInput = typeof ActivitySubscribeInput.Type;

export const ActivityCheckInGetInput = Schema.Struct({});
export const ActivityCheckInGetResult = Schema.Struct({
  checkIn: Schema.NullOr(ActivityCheckIn),
  events: Schema.Array(ActivityEvent),
  truncated: Schema.Boolean,
});
export type ActivityCheckInGetResult = typeof ActivityCheckInGetResult.Type;

/** Marks everything up to `seenSequence` (default: the latest event) as seen. */
export const ActivityMarkSeenInput = Schema.Struct({
  seenSequence: Schema.optional(NonNegativeInt),
});
export type ActivityMarkSeenInput = typeof ActivityMarkSeenInput.Type;

export class ActivityLedgerError extends Schema.TaggedError<ActivityLedgerError>()(
  "ActivityLedgerError",
  { message: Schema.String },
) {}

export const WorkReportStatus = Schema.Literals([
  "progress",
  "done",
  "blocked",
  "needs_you",
  "decision",
]);

export const WorkReportInput = Schema.Struct({
  status: WorkReportStatus,
  summary: ActivitySummary,
  commits: Schema.optional(ActivityCommits),
  tests: Schema.optional(ActivityTests),
  next: Schema.optional(ActivityNext),
  featureKey: Schema.optional(ActivityFeatureKey),
});
export type WorkReportInput = typeof WorkReportInput.Type;
