import { Schema } from "effect"

export class AssessChangesWorktreeContextMissingError extends Schema.TaggedError<AssessChangesWorktreeContextMissingError>()(
  "AssessChangesWorktreeContextMissingError",
  {
    workItemId: Schema.String,
    message: Schema.String,
  },
) {}

export class AssessChangesInvalidWorktreeContextError extends Schema.TaggedError<AssessChangesInvalidWorktreeContextError>()(
  "AssessChangesInvalidWorktreeContextError",
  {
    workItemId: Schema.String,
    worktreePath: Schema.String,
    message: Schema.String,
  },
) {}

export class AssessChangesStartingCommitMissingError extends Schema.TaggedError<AssessChangesStartingCommitMissingError>()(
  "AssessChangesStartingCommitMissingError",
  {
    workItemId: Schema.String,
    message: Schema.String,
  },
) {}

export class AssessChangesSessionMissingError extends Schema.TaggedError<AssessChangesSessionMissingError>()(
  "AssessChangesSessionMissingError",
  {
    workItemId: Schema.String,
    message: Schema.String,
  },
) {}

export class AssessChangesOpenCodeError extends Schema.TaggedError<AssessChangesOpenCodeError>()(
  "AssessChangesOpenCodeError",
  {
    workItemId: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class AssessChangesResultError extends Schema.TaggedError<AssessChangesResultError>()(
  "AssessChangesResultError",
  {
    workItemId: Schema.String,
    message: Schema.String,
  },
) {}

export type AssessChangesError =
  | AssessChangesWorktreeContextMissingError
  | AssessChangesInvalidWorktreeContextError
  | AssessChangesStartingCommitMissingError
  | AssessChangesSessionMissingError
  | AssessChangesOpenCodeError
  | AssessChangesResultError
