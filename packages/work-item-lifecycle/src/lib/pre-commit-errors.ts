import { Schema } from "effect"

export class PreCommitWorktreeContextMissingError extends Schema.TaggedError<PreCommitWorktreeContextMissingError>()(
  "PreCommitWorktreeContextMissingError",
  {
    workItemId: Schema.String,
    message: Schema.String,
  },
) {}

export class PreCommitInvalidWorktreeContextError extends Schema.TaggedError<PreCommitInvalidWorktreeContextError>()(
  "PreCommitInvalidWorktreeContextError",
  {
    workItemId: Schema.String,
    worktreePath: Schema.String,
    message: Schema.String,
  },
) {}

export class PreCommitStageError extends Schema.TaggedError<PreCommitStageError>()(
  "PreCommitStageError",
  {
    message: Schema.String,
    worktreePath: Schema.String,
    exitCode: Schema.Finite,
    output: Schema.String,
  },
) {}

export class PreCommitHookFailedError extends Schema.TaggedError<PreCommitHookFailedError>()(
  "PreCommitHookFailedError",
  {
    message: Schema.String,
    worktreePath: Schema.String,
    exitCode: Schema.Finite,
    output: Schema.String,
  },
) {}

export class PreCommitSessionContextMissingError extends Schema.TaggedError<PreCommitSessionContextMissingError>()(
  "PreCommitSessionContextMissingError",
  {
    workItemId: Schema.String,
    message: Schema.String,
  },
) {}

export class PreCommitOpenCodeError extends Schema.TaggedError<PreCommitOpenCodeError>()(
  "PreCommitOpenCodeError",
  {
    message: Schema.String,
    worktreePath: Schema.String,
    sessionId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export type PreCommitError =
  | PreCommitWorktreeContextMissingError
  | PreCommitInvalidWorktreeContextError
  | PreCommitStageError
  | PreCommitHookFailedError
  | PreCommitSessionContextMissingError
  | PreCommitOpenCodeError
