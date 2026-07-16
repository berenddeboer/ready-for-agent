import { Data } from "effect"

export class CreatePrWorktreeContextMissingError extends Data.TaggedError(
  "CreatePrWorktreeContextMissingError",
)<{
  readonly workItemId: string
  readonly message: string
}> {}

export class CreatePrInvalidWorktreeContextError extends Data.TaggedError(
  "CreatePrInvalidWorktreeContextError",
)<{
  readonly workItemId: string
  readonly worktreePath: string
  readonly message: string
}> {}

export class CreatePrSessionContextMissingError extends Data.TaggedError(
  "CreatePrSessionContextMissingError",
)<{
  readonly workItemId: string
  readonly message: string
}> {}

export class CreatePrCredentialError extends Data.TaggedError(
  "CreatePrCredentialError",
)<{
  readonly repositoryId: string
  readonly message: string
  readonly cause?: unknown
}> {}

export class CreatePrOpenCodeError extends Data.TaggedError(
  "CreatePrOpenCodeError",
)<{
  readonly message: string
  readonly worktreePath: string
  readonly sessionId?: string
  readonly cause?: unknown
}> {}

export class CreatePrLookupError extends Data.TaggedError(
  "CreatePrLookupError",
)<{
  readonly repositoryId: string
  readonly message: string
  readonly cause?: unknown
}> {}

export type CreatePrError =
  | CreatePrWorktreeContextMissingError
  | CreatePrInvalidWorktreeContextError
  | CreatePrSessionContextMissingError
  | CreatePrCredentialError
  | CreatePrOpenCodeError
  | CreatePrLookupError
