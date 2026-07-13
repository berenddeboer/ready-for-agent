import { Data } from "effect"

export class GitHubRepositoryUnavailableError extends Data.TaggedError(
  "GitHubRepositoryUnavailableError",
)<{
  readonly owner: string
  readonly name: string
}> {}

export class GitHubRequestError extends Data.TaggedError("GitHubRequestError")<{
  readonly message: string
  readonly cause?: unknown
}> {}
