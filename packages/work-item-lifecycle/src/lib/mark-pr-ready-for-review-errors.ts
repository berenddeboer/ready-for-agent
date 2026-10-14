import { Schema } from "effect"

export class MarkPrReadyForReviewContextError extends Schema.TaggedError<MarkPrReadyForReviewContextError>()(
  "MarkPrReadyForReviewContextError",
  {
    message: Schema.String,
  },
) {}

export class MarkPrReadyForReviewSessionContextMissingError extends Schema.TaggedError<MarkPrReadyForReviewSessionContextMissingError>()(
  "MarkPrReadyForReviewSessionContextMissingError",
  {
    workItemId: Schema.String,
    message: Schema.String,
  },
) {}

export class MarkPrReadyForReviewOpenCodeError extends Schema.TaggedError<MarkPrReadyForReviewOpenCodeError>()(
  "MarkPrReadyForReviewOpenCodeError",
  {
    message: Schema.String,
    worktreePath: Schema.String,
    sessionId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class MarkPrReadyForReviewPostconditionError extends Schema.TaggedError<MarkPrReadyForReviewPostconditionError>()(
  "MarkPrReadyForReviewPostconditionError",
  {
    repositoryId: Schema.String,
    message: Schema.String,
    diagnostics: Schema.optional(Schema.String),
  },
) {}

export type MarkPrReadyForReviewError =
  | MarkPrReadyForReviewContextError
  | MarkPrReadyForReviewSessionContextMissingError
  | MarkPrReadyForReviewOpenCodeError
  | MarkPrReadyForReviewPostconditionError
