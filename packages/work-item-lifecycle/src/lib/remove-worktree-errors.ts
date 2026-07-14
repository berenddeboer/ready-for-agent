import { Data } from "effect"

export class RemoveWorktreeCredentialError extends Data.TaggedError(
  "RemoveWorktreeCredentialError",
)<{
  readonly repositoryId: string
  readonly message: string
  readonly cause?: unknown
}> {}

export class RemoveWorktreeRemoteError extends Data.TaggedError(
  "RemoveWorktreeRemoteError",
)<{
  readonly message: string
  readonly branchName: string
  readonly cause?: unknown
}> {}
