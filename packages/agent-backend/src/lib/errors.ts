import { Schema } from "effect"

const AgentBackendProviderSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
})

export class AgentBackendConfigError extends Schema.TaggedErrorClass<AgentBackendConfigError>()(
  "AgentBackendConfigError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    /**
     * Optional hosting provider known at inspect failure (e.g. Claude Code
     * reported `apiProvider` while unauthenticated). Callers must not invent
     * this from env flags alone.
     */
    provider: Schema.optionalKey(AgentBackendProviderSchema),
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
