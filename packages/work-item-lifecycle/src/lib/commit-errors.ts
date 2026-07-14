import { Data } from "effect"

export class CommitWorktreeContextMissingError extends Data.TaggedError(
  "CommitWorktreeContextMissingError",
)<{
  readonly workItemId: string
  readonly message: string
}> {}

export class CommitInvalidWorktreeContextError extends Data.TaggedError(
  "CommitInvalidWorktreeContextError",
)<{
  readonly workItemId: string
  readonly worktreePath: string
  readonly message: string
}> {}

export class CommitStageError extends Data.TaggedError("CommitStageError")<{
  readonly message: string
  readonly worktreePath: string
  readonly exitCode: number
  readonly output: string
}> {}

export class CommitFailedError extends Data.TaggedError("CommitFailedError")<{
  readonly message: string
  readonly worktreePath: string
  readonly exitCode: number
  readonly output: string
}> {}

export type CommitError =
  | CommitWorktreeContextMissingError
  | CommitInvalidWorktreeContextError
  | CommitStageError
  | CommitFailedError
