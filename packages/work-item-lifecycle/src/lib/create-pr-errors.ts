import { Schema } from "effect"
import type { LinearRequestError } from "@ready-for-agent/linear-service"

export class CreatePrWorktreeContextMissingError extends Schema.TaggedError<CreatePrWorktreeContextMissingError>()(
  "CreatePrWorktreeContextMissingError",
  {
    workItemId: Schema.String,
    message: Schema.String,
  },
) {}

export class CreatePrInvalidWorktreeContextError extends Schema.TaggedError<CreatePrInvalidWorktreeContextError>()(
  "CreatePrInvalidWorktreeContextError",
  {
    workItemId: Schema.String,
    worktreePath: Schema.String,
    message: Schema.String,
  },
) {}

export class CreatePrSessionContextMissingError extends Schema.TaggedError<CreatePrSessionContextMissingError>()(
  "CreatePrSessionContextMissingError",
  {
    workItemId: Schema.String,
    message: Schema.String,
  },
) {}

export class CreatePrCredentialError extends Schema.TaggedError<CreatePrCredentialError>()(
  "CreatePrCredentialError",
  {
    repositoryId: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class CreatePrOpenCodeError extends Schema.TaggedError<CreatePrOpenCodeError>()(
  "CreatePrOpenCodeError",
  {
    message: Schema.String,
    worktreePath: Schema.String,
    sessionId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class CreatePrLookupError extends Schema.TaggedError<CreatePrLookupError>()(
  "CreatePrLookupError",
  {
    repositoryId: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class CreatePrPostconditionError extends Schema.TaggedError<CreatePrPostconditionError>()(
  "CreatePrPostconditionError",
  {
    repositoryId: Schema.String,
    message: Schema.String,
    diagnostics: Schema.optional(Schema.String),
  },
) {}

export type CreatePrError =
  | CreatePrWorktreeContextMissingError
  | CreatePrInvalidWorktreeContextError
  | CreatePrSessionContextMissingError
  | CreatePrCredentialError
  | CreatePrOpenCodeError
  | CreatePrLookupError
  | CreatePrPostconditionError
  | LinearRequestError
