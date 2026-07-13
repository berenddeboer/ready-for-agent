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

export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly message: string
  readonly cause?: unknown
}> {}
