import { Data } from "effect"

export class PreCommitWorktreeContextMissingError extends Data.TaggedError(
  "PreCommitWorktreeContextMissingError",
)<{
  readonly workItemId: string
  readonly message: string
}> {}

export class PreCommitInvalidWorktreeContextError extends Data.TaggedError(
  "PreCommitInvalidWorktreeContextError",
)<{
  readonly workItemId: string
  readonly worktreePath: string
  readonly message: string
}> {}

export class PreCommitStageError extends Data.TaggedError(
  "PreCommitStageError",
)<{
  readonly message: string
  readonly worktreePath: string
  readonly exitCode: number
  readonly output: string
}> {}

export class PreCommitHookFailedError extends Data.TaggedError(
  "PreCommitHookFailedError",
)<{
  readonly message: string
  readonly worktreePath: string
  readonly exitCode: number
  readonly output: string
}> {}

export class PreCommitSessionContextMissingError extends Data.TaggedError(
  "PreCommitSessionContextMissingError",
)<{
  readonly workItemId: string
  readonly message: string
}> {}

export class PreCommitOpenCodeError extends Data.TaggedError(
  "PreCommitOpenCodeError",
)<{
  readonly message: string
  readonly worktreePath: string
  readonly sessionId: string
  readonly cause?: unknown
}> {}

export type PreCommitError =
  | PreCommitWorktreeContextMissingError
  | PreCommitInvalidWorktreeContextError
  | PreCommitStageError
  | PreCommitHookFailedError
  | PreCommitSessionContextMissingError
  | PreCommitOpenCodeError
