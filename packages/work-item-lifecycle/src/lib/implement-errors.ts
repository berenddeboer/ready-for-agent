import { Schema } from "effect"
import type {
  LinearNotConfiguredError,
  LinearRequestError,
} from "@ready-for-agent/linear-service"

export class ImplementWorktreeContextMissingError extends Schema.TaggedError<ImplementWorktreeContextMissingError>()(
  "ImplementWorktreeContextMissingError",
  {
    workItemId: Schema.String,
    message: Schema.String,
  },
) {}

export class ImplementInvalidWorktreeContextError extends Schema.TaggedError<ImplementInvalidWorktreeContextError>()(
  "ImplementInvalidWorktreeContextError",
  {
    workItemId: Schema.String,
    worktreePath: Schema.String,
    message: Schema.String,
  },
) {}

export class ImplementRepositoryNotFoundError extends Schema.TaggedError<ImplementRepositoryNotFoundError>()(
  "ImplementRepositoryNotFoundError",
  {
    repositoryId: Schema.String,
    message: Schema.String,
  },
) {}

export class ImplementIssueContextMissingError extends Schema.TaggedError<ImplementIssueContextMissingError>()(
  "ImplementIssueContextMissingError",
  {
    workItemId: Schema.String,
    message: Schema.String,
  },
) {}

export class ImplementForgeCredentialError extends Schema.TaggedError<ImplementForgeCredentialError>()(
  "ImplementForgeCredentialError",
  {
    repositoryId: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class ImplementOpenCodeError extends Schema.TaggedError<ImplementOpenCodeError>()(
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
  | ImplementForgeCredentialError
  | ImplementOpenCodeError
  | LinearRequestError
  | LinearNotConfiguredError
