import { Schema } from "effect"

export class ImplementWorktreeContextMissingError extends Schema.TaggedErrorClass<ImplementWorktreeContextMissingError>()(
  "ImplementWorktreeContextMissingError",
  {
    workItemId: Schema.String,
    message: Schema.String,
  },
) {}

export class ImplementInvalidWorktreeContextError extends Schema.TaggedErrorClass<ImplementInvalidWorktreeContextError>()(
  "ImplementInvalidWorktreeContextError",
  {
    workItemId: Schema.String,
    worktreePath: Schema.String,
    message: Schema.String,
  },
) {}

export class ImplementRepositoryNotFoundError extends Schema.TaggedErrorClass<ImplementRepositoryNotFoundError>()(
  "ImplementRepositoryNotFoundError",
  {
    repositoryId: Schema.String,
    message: Schema.String,
  },
) {}

export class ImplementIssueContextMissingError extends Schema.TaggedErrorClass<ImplementIssueContextMissingError>()(
  "ImplementIssueContextMissingError",
  {
    workItemId: Schema.String,
    message: Schema.String,
  },
) {}

export class ImplementOpenCodeError extends Schema.TaggedErrorClass<ImplementOpenCodeError>()(
  "ImplementOpenCodeError",
  {
    message: Schema.String,
    worktreePath: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export type ImplementError =
  | ImplementWorktreeContextMissingError
  | ImplementInvalidWorktreeContextError
  | ImplementRepositoryNotFoundError
  | ImplementIssueContextMissingError
  | ImplementOpenCodeError
