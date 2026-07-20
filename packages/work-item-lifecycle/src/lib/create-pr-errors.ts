import { Schema } from "effect"

export class CreatePrWorktreeContextMissingError extends Schema.TaggedErrorClass<CreatePrWorktreeContextMissingError>()(
  "CreatePrWorktreeContextMissingError",
  {
    workItemId: Schema.String,
    message: Schema.String,
  },
) {}

export class CreatePrInvalidWorktreeContextError extends Schema.TaggedErrorClass<CreatePrInvalidWorktreeContextError>()(
  "CreatePrInvalidWorktreeContextError",
  {
    workItemId: Schema.String,
    worktreePath: Schema.String,
    message: Schema.String,
  },
) {}

export class CreatePrSessionContextMissingError extends Schema.TaggedErrorClass<CreatePrSessionContextMissingError>()(
  "CreatePrSessionContextMissingError",
  {
    workItemId: Schema.String,
    message: Schema.String,
  },
) {}

export class CreatePrCredentialError extends Schema.TaggedErrorClass<CreatePrCredentialError>()(
  "CreatePrCredentialError",
  {
    repositoryId: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class CreatePrOpenCodeError extends Schema.TaggedErrorClass<CreatePrOpenCodeError>()(
  "CreatePrOpenCodeError",
  {
    message: Schema.String,
    worktreePath: Schema.String,
    sessionId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class CreatePrLookupError extends Schema.TaggedErrorClass<CreatePrLookupError>()(
  "CreatePrLookupError",
  {
    repositoryId: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export type CreatePrError =
  | CreatePrWorktreeContextMissingError
  | CreatePrInvalidWorktreeContextError
  | CreatePrSessionContextMissingError
  | CreatePrCredentialError
  | CreatePrOpenCodeError
  | CreatePrLookupError
