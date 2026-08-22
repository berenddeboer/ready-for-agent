import { Schema } from "effect"

export class MarkPrReadyForReviewContextError extends Schema.TaggedErrorClass<MarkPrReadyForReviewContextError>()(
  "MarkPrReadyForReviewContextError",
  {
    message: Schema.String,
  },
) {}

export class MarkPrReadyForReviewSessionContextMissingError extends Schema.TaggedErrorClass<MarkPrReadyForReviewSessionContextMissingError>()(
  "MarkPrReadyForReviewSessionContextMissingError",
  {
    workItemId: Schema.String,
    message: Schema.String,
  },
) {}

export class MarkPrReadyForReviewOpenCodeError extends Schema.TaggedErrorClass<MarkPrReadyForReviewOpenCodeError>()(
  "MarkPrReadyForReviewOpenCodeError",
  {
    message: Schema.String,
    worktreePath: Schema.String,
    sessionId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class MarkPrReadyForReviewPostconditionError extends Schema.TaggedErrorClass<MarkPrReadyForReviewPostconditionError>()(
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
