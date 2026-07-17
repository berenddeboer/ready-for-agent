import { Data } from "effect"

export class InvalidRepositoryInputError extends Data.TaggedError(
  "InvalidRepositoryInputError",
)<{
  readonly field: "githubOwner" | "githubRepo" | "localPath"
  readonly message: string
}> {}

export class RepositoryAlreadyExistsError extends Data.TaggedError(
  "RepositoryAlreadyExistsError",
)<{
  readonly githubOwner: string
  readonly githubRepo: string
}> {}

export class LocalPathInUseError extends Data.TaggedError(
  "LocalPathInUseError",
)<{
  readonly localPath: string
}> {}

export class RepositoryNotFoundError extends Data.TaggedError(
  "RepositoryNotFoundError",
)<{
  readonly repositoryId: string
}> {}

export class RepositoryHasRunningStepError extends Data.TaggedError(
  "RepositoryHasRunningStepError",
)<{
  readonly repositoryId: string
  readonly stepRunId: string
  readonly workItemId: string
}> {}

export class InvalidIssueInputError extends Data.TaggedError(
  "InvalidIssueInputError",
)<{
  readonly field:
    | "githubIssueNumber"
    | "title"
    | "url"
    | "state"
    | "githubCreatedAt"
    | "parent"
    | "parentPosition"
    | "blockedBy"
  readonly message: string
}> {}

export class InvalidConfigInputError extends Data.TaggedError(
  "InvalidConfigInputError",
)<{
  readonly field:
    | "defaultModel"
    | "defaultVariant"
    | "reviewModel"
    | "reviewVariant"
    | "maxConcurrentOpencodeSessions"
  readonly message: string
}> {}

export class InvalidRepositorySettingsError extends Data.TaggedError(
  "InvalidRepositorySettingsError",
)<{
  readonly field:
    | "defaultModel"
    | "defaultVariant"
    | "reviewModel"
    | "reviewVariant"
  readonly message: string
}> {}

export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly message: string
  readonly cause?: unknown
}> {}
