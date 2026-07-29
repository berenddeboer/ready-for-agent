import { Schema } from "effect"

export class GitHubRepositoryUnavailableError extends Schema.TaggedErrorClass<GitHubRepositoryUnavailableError>()(
  "GitHubRepositoryUnavailableError",
  {
    forge: Schema.String,
    forgeHost: Schema.String,
    projectPath: Schema.String,
  },
) {}

export class GitHubRequestError extends Schema.TaggedErrorClass<GitHubRequestError>()(
  "GitHubRequestError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    statusCode: Schema.optional(Schema.Finite),
  },
) {}
