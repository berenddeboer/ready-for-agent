import { Schema } from "effect"

export class CommitWorktreeContextMissingError extends Schema.TaggedErrorClass<CommitWorktreeContextMissingError>()(
  "CommitWorktreeContextMissingError",
  {
    workItemId: Schema.String,
    message: Schema.String,
  },
) {}

export class CommitInvalidWorktreeContextError extends Schema.TaggedErrorClass<CommitInvalidWorktreeContextError>()(
  "CommitInvalidWorktreeContextError",
  {
    workItemId: Schema.String,
    worktreePath: Schema.String,
    message: Schema.String,
  },
) {}

export class CommitSessionContextMissingError extends Schema.TaggedErrorClass<CommitSessionContextMissingError>()(
  "CommitSessionContextMissingError",
  {
    workItemId: Schema.String,
    message: Schema.String,
  },
) {}

export class CommitOpenCodeError extends Schema.TaggedErrorClass<CommitOpenCodeError>()(
  "CommitOpenCodeError",
  {
    message: Schema.String,
    worktreePath: Schema.String,
    sessionId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export type CommitError =
  | CommitWorktreeContextMissingError
  | CommitInvalidWorktreeContextError
  | CommitSessionContextMissingError
  | CommitOpenCodeError
