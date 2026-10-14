import { Schema } from "effect"

export class CreateWorktreeRepositoryNotFoundError extends Schema.TaggedError<CreateWorktreeRepositoryNotFoundError>()(
  "CreateWorktreeRepositoryNotFoundError",
  {
    repositoryId: Schema.String,
  },
) {}

export class WorktreeConflictError extends Schema.TaggedError<WorktreeConflictError>()(
  "WorktreeConflictError",
  {
    message: Schema.String,
    branchName: Schema.String,
    worktreePath: Schema.String,
  },
) {}

export class GitCommandError extends Schema.TaggedError<GitCommandError>()(
  "GitCommandError",
  {
    message: Schema.String,
    command: Schema.String,
    args: Schema.Array(Schema.String),
    cwd: Schema.optional(Schema.String),
    exitCode: Schema.Finite,
    stderr: Schema.String,
  },
) {}

export type CreateWorktreeError =
  | CreateWorktreeRepositoryNotFoundError
  | WorktreeConflictError
  | GitCommandError
