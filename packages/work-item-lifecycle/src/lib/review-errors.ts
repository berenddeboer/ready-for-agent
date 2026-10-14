import { Schema } from "effect"

export class ReviewWorktreeContextMissingError extends Schema.TaggedError<ReviewWorktreeContextMissingError>()(
  "ReviewWorktreeContextMissingError",
  {
    workItemId: Schema.String,
    message: Schema.String,
  },
) {}

export class ReviewInvalidWorktreeContextError extends Schema.TaggedError<ReviewInvalidWorktreeContextError>()(
  "ReviewInvalidWorktreeContextError",
  {
    workItemId: Schema.String,
    worktreePath: Schema.String,
    message: Schema.String,
  },
) {}

export class ReviewSessionContextMissingError extends Schema.TaggedError<ReviewSessionContextMissingError>()(
  "ReviewSessionContextMissingError",
  {
    workItemId: Schema.String,
    message: Schema.String,
  },
) {}

export class ReviewOpenCodeError extends Schema.TaggedError<ReviewOpenCodeError>()(
  "ReviewOpenCodeError",
  {
    message: Schema.String,
    worktreePath: Schema.String,
    sessionId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class ReviewResultError extends Schema.TaggedError<ReviewResultError>()(
  "ReviewResultError",
  {
    workItemId: Schema.String,
    message: Schema.String,
  },
) {}

export type ReviewError =
  | ReviewWorktreeContextMissingError
  | ReviewInvalidWorktreeContextError
  | ReviewSessionContextMissingError
  | ReviewOpenCodeError
  | ReviewResultError
