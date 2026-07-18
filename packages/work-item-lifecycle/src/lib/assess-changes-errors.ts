import { Data } from "effect"

export class AssessChangesWorktreeContextMissingError extends Data.TaggedError(
  "AssessChangesWorktreeContextMissingError",
)<{
  readonly workItemId: string
  readonly message: string
}> {}

export class AssessChangesInvalidWorktreeContextError extends Data.TaggedError(
  "AssessChangesInvalidWorktreeContextError",
)<{
  readonly workItemId: string
  readonly worktreePath: string
  readonly message: string
}> {}

export class AssessChangesStartingCommitMissingError extends Data.TaggedError(
  "AssessChangesStartingCommitMissingError",
)<{
  readonly workItemId: string
  readonly message: string
}> {}

export class AssessChangesSessionMissingError extends Data.TaggedError(
  "AssessChangesSessionMissingError",
)<{
  readonly workItemId: string
  readonly message: string
}> {}

export class AssessChangesOpenCodeError extends Data.TaggedError(
  "AssessChangesOpenCodeError",
)<{
  readonly workItemId: string
  readonly message: string
  readonly cause?: unknown
}> {}

export class AssessChangesResultError extends Data.TaggedError(
  "AssessChangesResultError",
)<{
  readonly workItemId: string
  readonly message: string
}> {}

export type AssessChangesError =
  | AssessChangesWorktreeContextMissingError
  | AssessChangesInvalidWorktreeContextError
  | AssessChangesStartingCommitMissingError
  | AssessChangesSessionMissingError
  | AssessChangesOpenCodeError
  | AssessChangesResultError
