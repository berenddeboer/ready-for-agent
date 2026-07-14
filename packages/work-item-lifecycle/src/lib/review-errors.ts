import { Data } from "effect"

export class ReviewWorktreeContextMissingError extends Data.TaggedError(
  "ReviewWorktreeContextMissingError",
)<{
  readonly workItemId: string
  readonly message: string
}> {}

export class ReviewInvalidWorktreeContextError extends Data.TaggedError(
  "ReviewInvalidWorktreeContextError",
)<{
  readonly workItemId: string
  readonly worktreePath: string
  readonly message: string
}> {}

export class ReviewSessionContextMissingError extends Data.TaggedError(
  "ReviewSessionContextMissingError",
)<{
  readonly workItemId: string
  readonly message: string
}> {}

export class ReviewOpenCodeError extends Data.TaggedError(
  "ReviewOpenCodeError",
)<{
  readonly message: string
  readonly worktreePath: string
  readonly sessionId?: string
  readonly cause?: unknown
}> {}

export type ReviewError =
  | ReviewWorktreeContextMissingError
  | ReviewInvalidWorktreeContextError
  | ReviewSessionContextMissingError
  | ReviewOpenCodeError
