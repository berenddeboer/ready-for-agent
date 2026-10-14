import { Schema } from "effect"

export class LinearRequestError extends Schema.TaggedError<LinearRequestError>()(
  "LinearRequestError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    statusCode: Schema.optional(Schema.Finite),
    code: Schema.optional(Schema.String),
  },
) {}

export class LinearNotConfiguredError extends Schema.TaggedError<LinearNotConfiguredError>()(
  "LinearNotConfiguredError",
  {
    repositoryId: Schema.String,
    message: Schema.String,
  },
) {}

export class LinearExecutionNotSupportedError extends Schema.TaggedError<LinearExecutionNotSupportedError>()(
  "LinearExecutionNotSupportedError",
  {
    repositoryId: Schema.String,
    message: Schema.String,
  },
) {}

export const linearExecutionNotSupported = (repositoryId: string) =>
  new LinearExecutionNotSupportedError({
    repositoryId,
    message:
      "Linear Issue execution is not available yet. Discovery and settings work; implementation lands in a follow-up.",
  })
