import { Schema } from "effect"

export class GitLabProjectUnavailableError extends Schema.TaggedError<GitLabProjectUnavailableError>()(
  "GitLabProjectUnavailableError",
  {
    forge: Schema.String,
    forgeHost: Schema.String,
    projectPath: Schema.String,
  },
) {}

export class GitLabRequestError extends Schema.TaggedError<GitLabRequestError>()(
  "GitLabRequestError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    statusCode: Schema.optional(Schema.Finite),
    /**
     * Machine-readable discriminator lifted from the nested cause chain
     * when available (e.g. TLS or DNS codes).
     */
    code: Schema.optional(Schema.String),
  },
) {}
