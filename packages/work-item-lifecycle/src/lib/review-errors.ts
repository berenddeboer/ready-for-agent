import { Schema } from "effect"

export class ReviewWorktreeContextMissingError extends Schema.TaggedErrorClass<ReviewWorktreeContextMissingError>()(
  "ReviewWorktreeContextMissingError",
  {
    workItemId: Schema.String,
    message: Schema.String,
  },
) {}

export class ReviewInvalidWorktreeContextError extends Schema.TaggedErrorClass<ReviewInvalidWorktreeContextError>()(
  "ReviewInvalidWorktreeContextError",
  {
    workItemId: Schema.String,
    worktreePath: Schema.String,
    message: Schema.String,
  },
) {}

export class ReviewSessionContextMissingError extends Schema.TaggedErrorClass<ReviewSessionContextMissingError>()(
  "ReviewSessionContextMissingError",
  {
    workItemId: Schema.String,
    message: Schema.String,
  },
) {}

export class ReviewOpenCodeError extends Schema.TaggedErrorClass<ReviewOpenCodeError>()(
  "ReviewOpenCodeError",
  {
    message: Schema.String,
    worktreePath: Schema.String,
    sessionId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export type ReviewError =
  | ReviewWorktreeContextMissingError
  | ReviewInvalidWorktreeContextError
  | ReviewSessionContextMissingError
  | ReviewOpenCodeError
