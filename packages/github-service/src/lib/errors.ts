import { Schema } from "effect"

export class GitHubRepositoryUnavailableError extends Schema.TaggedErrorClass<GitHubRepositoryUnavailableError>()(
  "GitHubRepositoryUnavailableError",
  {
    owner: Schema.String,
    name: Schema.String,
  },
) {}

export class GitHubRequestError extends Schema.TaggedErrorClass<GitHubRequestError>()(
  "GitHubRequestError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
