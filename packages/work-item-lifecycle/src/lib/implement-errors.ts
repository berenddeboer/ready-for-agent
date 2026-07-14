import { Data } from "effect"

export class ImplementWorktreeContextMissingError extends Data.TaggedError(
  "ImplementWorktreeContextMissingError",
)<{
  readonly workItemId: string
  readonly message: string
}> {}

export class ImplementInvalidWorktreeContextError extends Data.TaggedError(
  "ImplementInvalidWorktreeContextError",
)<{
  readonly workItemId: string
  readonly worktreePath: string
  readonly message: string
}> {}

export class ImplementRepositoryNotFoundError extends Data.TaggedError(
  "ImplementRepositoryNotFoundError",
)<{
  readonly repositoryId: string
  readonly message: string
}> {}

export class ImplementIssueContextMissingError extends Data.TaggedError(
  "ImplementIssueContextMissingError",
)<{
  readonly workItemId: string
  readonly message: string
}> {}

export class ImplementOpenCodeError extends Data.TaggedError(
  "ImplementOpenCodeError",
)<{
  readonly message: string
  readonly worktreePath: string
  readonly cause?: unknown
}> {}

export type ImplementError =
  | ImplementWorktreeContextMissingError
  | ImplementInvalidWorktreeContextError
  | ImplementRepositoryNotFoundError
  | ImplementIssueContextMissingError
  | ImplementOpenCodeError
