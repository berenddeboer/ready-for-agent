import { Schema } from "effect"

export class AssessChangesWorktreeContextMissingError extends Schema.TaggedErrorClass<AssessChangesWorktreeContextMissingError>()(
  "AssessChangesWorktreeContextMissingError",
  {
    workItemId: Schema.String,
    message: Schema.String,
  },
) {}

export class AssessChangesInvalidWorktreeContextError extends Schema.TaggedErrorClass<AssessChangesInvalidWorktreeContextError>()(
  "AssessChangesInvalidWorktreeContextError",
  {
    workItemId: Schema.String,
    worktreePath: Schema.String,
    message: Schema.String,
  },
) {}

export class AssessChangesStartingCommitMissingError extends Schema.TaggedErrorClass<AssessChangesStartingCommitMissingError>()(
  "AssessChangesStartingCommitMissingError",
  {
    workItemId: Schema.String,
    message: Schema.String,
  },
) {}

export class AssessChangesSessionMissingError extends Schema.TaggedErrorClass<AssessChangesSessionMissingError>()(
  "AssessChangesSessionMissingError",
  {
    workItemId: Schema.String,
    message: Schema.String,
  },
) {}

export class AssessChangesOpenCodeError extends Schema.TaggedErrorClass<AssessChangesOpenCodeError>()(
  "AssessChangesOpenCodeError",
  {
    workItemId: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class AssessChangesResultError extends Schema.TaggedErrorClass<AssessChangesResultError>()(
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
