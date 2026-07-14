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

export class CommitSessionContextMissingError extends Data.TaggedError(
  "CommitSessionContextMissingError",
)<{
  readonly workItemId: string
  readonly message: string
}> {}

export class CommitOpenCodeError extends Data.TaggedError(
  "CommitOpenCodeError",
)<{
  readonly message: string
  readonly worktreePath: string
  readonly sessionId?: string
  readonly cause?: unknown
}> {}

export type CommitError =
  | CommitWorktreeContextMissingError
  | CommitInvalidWorktreeContextError
  | CommitSessionContextMissingError
  | CommitOpenCodeError
