import { Schema } from "effect"

export class OpencodeExitError extends Schema.TaggedErrorClass<OpencodeExitError>()(
  "OpencodeExitError",
  {
    exitCode: Schema.Finite,
    cwd: Schema.String,
    sessionId: Schema.optionalKey(Schema.String),
  },
) {}

export class OpencodeTimeoutError extends Schema.TaggedErrorClass<OpencodeTimeoutError>()(
  "OpencodeTimeoutError",
  {
    cwd: Schema.String,
    timeoutMs: Schema.Finite,
    sessionId: Schema.optionalKey(Schema.String),
  },
) {}

export class SessionIdNotFoundError extends Schema.TaggedErrorClass<SessionIdNotFoundError>()(
  "SessionIdNotFoundError",
  {
    cwd: Schema.String,
  },
) {}
