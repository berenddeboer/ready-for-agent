import { Schema } from "effect"

export class GitLabProjectUnavailableError extends Schema.TaggedErrorClass<GitLabProjectUnavailableError>()(
  "GitLabProjectUnavailableError",
  {
    forge: Schema.String,
    forgeHost: Schema.String,
    projectPath: Schema.String,
  },
) {}

export class GitLabRequestError extends Schema.TaggedErrorClass<GitLabRequestError>()(
  "GitLabRequestError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    statusCode: Schema.optional(Schema.Finite),
  },
) {}
