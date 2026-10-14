import { Schema } from "effect"

export class CommitWorktreeContextMissingError extends Schema.TaggedError<CommitWorktreeContextMissingError>()(
  "CommitWorktreeContextMissingError",
  {
    workItemId: Schema.String,
    message: Schema.String,
  },
) {}

export class CommitInvalidWorktreeContextError extends Schema.TaggedError<CommitInvalidWorktreeContextError>()(
  "CommitInvalidWorktreeContextError",
  {
    workItemId: Schema.String,
    worktreePath: Schema.String,
    message: Schema.String,
  },
) {}

export class CommitSessionContextMissingError extends Schema.TaggedError<CommitSessionContextMissingError>()(
  "CommitSessionContextMissingError",
  {
    workItemId: Schema.String,
    message: Schema.String,
  },
) {}

export class CommitStartingCommitMissingError extends Schema.TaggedError<CommitStartingCommitMissingError>()(
  "CommitStartingCommitMissingError",
  {
    workItemId: Schema.String,
    message: Schema.String,
  },
) {}

export class CommitOpenCodeError extends Schema.TaggedError<CommitOpenCodeError>()(
  "CommitOpenCodeError",
  {
    message: Schema.String,
    worktreePath: Schema.String,
    sessionId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class CommitPostconditionError extends Schema.TaggedError<CommitPostconditionError>()(
  "CommitPostconditionError",
  {
    message: Schema.String,
    worktreePath: Schema.String,
    diagnostics: Schema.optional(Schema.String),
  },
) {}

export class CommitPublicationCopyError extends Schema.TaggedError<CommitPublicationCopyError>()(
  "CommitPublicationCopyError",
  {
    workItemId: Schema.String,
    message: Schema.String,
  },
) {}

export class CommitNoChangeConfirmationError extends Schema.TaggedError<CommitNoChangeConfirmationError>()(
  "CommitNoChangeConfirmationError",
  {
    workItemId: Schema.String,
    message: Schema.String,
  },
) {}

export type CommitError =
  | CommitWorktreeContextMissingError
  | CommitInvalidWorktreeContextError
  | CommitSessionContextMissingError
  | CommitStartingCommitMissingError
  | CommitOpenCodeError
  | CommitPostconditionError
  | CommitPublicationCopyError
  | CommitNoChangeConfirmationError
