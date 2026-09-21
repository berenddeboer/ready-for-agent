import { Schema } from "effect"

export class LinearRequestError extends Schema.TaggedErrorClass<LinearRequestError>()(
  "LinearRequestError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    statusCode: Schema.optional(Schema.Finite),
    code: Schema.optional(Schema.String),
  },
) {}

export class LinearNotConfiguredError extends Schema.TaggedErrorClass<LinearNotConfiguredError>()(
  "LinearNotConfiguredError",
  {
    repositoryId: Schema.String,
    message: Schema.String,
  },
) {}

export class LinearExecutionNotSupportedError extends Schema.TaggedErrorClass<LinearExecutionNotSupportedError>()(
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
