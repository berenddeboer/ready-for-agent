import { Schema } from "effect"

const AgentBackendProviderSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
})

/**
 * Classification of a provider-side failure recognized from a backend's
 * JSONL error event, e.g. OpenCode's `error` / `step_finish` stream events.
 * `retryable_provider_error` covers rate limits and transient 5xx that the
 * lifecycle's retry should attempt again. `length_limit_truncation` covers a
 * response cut off by the model's output/context limit (finish reason
 * `"length"`, or a provider context-overflow error) — a Work Item hand-off
 * case, not a retry. `terminal_auth_error` covers a provider rejecting
 * credentials mid-turn — also a hand-off case, kept distinct from
 * `length_limit_truncation` so a human sees the real cause. Unrecognized
 * error payloads carry no classification, so callers fall back to generic
 * handling.
 */
export const AgentBackendErrorClassification = Schema.Literals([
  "retryable_provider_error",
  "length_limit_truncation",
  "terminal_auth_error",
])
export type AgentBackendErrorClassification =
  typeof AgentBackendErrorClassification.Type

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
    /**
     * Set when a backend's JSONL stream contained a recognizable provider
     * error event before exit, so the Work Item lifecycle's retry/handoff
     * decisions can distinguish e.g. a rate limit from context overflow.
     * Absent when the stream carried no recognizable error (today's
     * behavior) or an unrecognized error payload.
     */
    classification: Schema.optionalKey(AgentBackendErrorClassification),
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

/**
 * The Agent Turn CLI produced no stdout output within the startup window, so
 * it never began the turn (bad auth, broken config, crash during startup).
 * Distinct from AgentBackendTimeoutError, which means the turn ran out of time.
 */
export class AgentBackendStartupTimeoutError extends Schema.TaggedErrorClass<AgentBackendStartupTimeoutError>()(
  "AgentBackendStartupTimeoutError",
  {
    cwd: Schema.String,
    startupTimeoutMs: Schema.Finite,
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
