import { Schema } from "effect"

export class PreCommitWorktreeContextMissingError extends Schema.TaggedErrorClass<PreCommitWorktreeContextMissingError>()(
  "PreCommitWorktreeContextMissingError",
  {
    workItemId: Schema.String,
    message: Schema.String,
  },
) {}

export class PreCommitInvalidWorktreeContextError extends Schema.TaggedErrorClass<PreCommitInvalidWorktreeContextError>()(
  "PreCommitInvalidWorktreeContextError",
  {
    workItemId: Schema.String,
    worktreePath: Schema.String,
    message: Schema.String,
  },
) {}

export class PreCommitStageError extends Schema.TaggedErrorClass<PreCommitStageError>()(
  "PreCommitStageError",
  {
    message: Schema.String,
    worktreePath: Schema.String,
    exitCode: Schema.Finite,
    output: Schema.String,
  },
) {}

export class PreCommitHookFailedError extends Schema.TaggedErrorClass<PreCommitHookFailedError>()(
  "PreCommitHookFailedError",
  {
    message: Schema.String,
    worktreePath: Schema.String,
    exitCode: Schema.Finite,
    output: Schema.String,
  },
) {}

export class PreCommitSessionContextMissingError extends Schema.TaggedErrorClass<PreCommitSessionContextMissingError>()(
  "PreCommitSessionContextMissingError",
  {
    workItemId: Schema.String,
    message: Schema.String,
  },
) {}

export class PreCommitOpenCodeError extends Schema.TaggedErrorClass<PreCommitOpenCodeError>()(
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
