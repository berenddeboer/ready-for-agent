import { Schema } from "effect"

export class AgentBackendConfigError extends Schema.TaggedErrorClass<AgentBackendConfigError>()(
  "AgentBackendConfigError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class AgentBackendExitError extends Schema.TaggedErrorClass<AgentBackendExitError>()(
  "AgentBackendExitError",
  {
    exitCode: Schema.Finite,
    cwd: Schema.String,
    sessionId: Schema.optionalKey(Schema.String),
  },
) {}

export class AgentBackendTimeoutError extends Schema.TaggedErrorClass<AgentBackendTimeoutError>()(
  "AgentBackendTimeoutError",
  {
    cwd: Schema.String,
    timeoutMs: Schema.Finite,
    sessionId: Schema.optionalKey(Schema.String),
  },
) {}

export class AgentBackendSessionIdMissingError extends Schema.TaggedErrorClass<AgentBackendSessionIdMissingError>()(
  "AgentBackendSessionIdMissingError",
  {
    cwd: Schema.String,
  },
) {}

export class AgentBackendMalformedOutputError extends Schema.TaggedErrorClass<AgentBackendMalformedOutputError>()(
  "AgentBackendMalformedOutputError",
  {
    cwd: Schema.String,
    byteLength: Schema.Finite,
  },
) {}
