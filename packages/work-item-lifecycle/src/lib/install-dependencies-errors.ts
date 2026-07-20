import { Schema } from "effect"

export class WorktreeContextMissingError extends Schema.TaggedErrorClass<WorktreeContextMissingError>()(
  "WorktreeContextMissingError",
  {
    workItemId: Schema.String,
    message: Schema.String,
  },
) {}

export class InvalidWorktreeContextError extends Schema.TaggedErrorClass<InvalidWorktreeContextError>()(
  "InvalidWorktreeContextError",
  {
    workItemId: Schema.String,
    worktreePath: Schema.String,
    message: Schema.String,
  },
) {}

export class InstallCommandError extends Schema.TaggedErrorClass<InstallCommandError>()(
  "InstallCommandError",
  {
    message: Schema.String,
    command: Schema.String,
    args: Schema.Array(Schema.String),
    cwd: Schema.String,
    exitCode: Schema.Finite,
    stderr: Schema.String,
  },
) {}

export class InstallDependenciesFallbackError extends Schema.TaggedErrorClass<InstallDependenciesFallbackError>()(
  "InstallDependenciesFallbackError",
  {
    message: Schema.String,
    worktreePath: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export type InstallDependenciesError =
  | WorktreeContextMissingError
  | InvalidWorktreeContextError
  | InstallCommandError
  | InstallDependenciesFallbackError
