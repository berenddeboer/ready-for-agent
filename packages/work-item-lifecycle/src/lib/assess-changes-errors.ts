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

export class AssessChangesNoObservableChangeError extends Data.TaggedError(
  "AssessChangesNoObservableChangeError",
)<{
  readonly workItemId: string
  readonly startingCommitOid: string
  readonly message: string
}> {}

export type AssessChangesError =
  | AssessChangesWorktreeContextMissingError
  | AssessChangesInvalidWorktreeContextError
  | AssessChangesStartingCommitMissingError
  | AssessChangesNoObservableChangeError
