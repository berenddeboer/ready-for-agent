import { Schema } from "effect"
import { classifyProviderCredentialText } from "./classify-credential-error.js"
import { sanitizeAgentBackendExitMessage } from "./sanitize-exit-message.js"

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

const SILENT_AGENT_BACKEND_LABEL = "Agent Backend"

/** Stable reason when a non-zero exit has no parsed adapter text or stderr. */
export const formatSilentAgentBackendExitMessage = (input: {
  readonly backendLabel: string
  readonly exitCode: number
}): string => `${input.backendLabel} failed with exit code ${input.exitCode}`

type AgentBackendExitErrorProps = {
  readonly exitCode: number
  readonly cwd: string
  readonly sessionId?: string
  readonly classification?: AgentBackendErrorClassification
  /** Best available human-readable reason. Always non-empty after `.new()`. */
  readonly message: string
}

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
    /** Best available human-readable reason. Never empty after construction. */
    message: Schema.String,
  },
) {
  /** Sanitize the operator-visible reason before the Schema constructor. */
  static new(props: AgentBackendExitErrorProps): AgentBackendExitError {
    const sanitized = sanitizeAgentBackendExitMessage(props.message)
    const classifiedFromText =
      props.classification === undefined
        ? classifyProviderCredentialText(props.message)
        : undefined
    const classification =
      props.classification ?? classifiedFromText?.classification
    return new AgentBackendExitError({
      exitCode: props.exitCode,
      cwd: props.cwd,
      ...(props.sessionId !== undefined ? { sessionId: props.sessionId } : {}),
      ...(classification !== undefined ? { classification } : {}),
      message:
        sanitized.length > 0
          ? sanitized
          : formatSilentAgentBackendExitMessage({
              backendLabel: SILENT_AGENT_BACKEND_LABEL,
              exitCode: props.exitCode,
            }),
    })
  }
}

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

export const isAgentBackendMalformedOutputError = (
  value: unknown,
): value is AgentBackendMalformedOutputError =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === "AgentBackendMalformedOutputError"

const AgentBackendDescriptorSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
})

/** Agent Backend CLI binary was not found on the Harness PATH (spawn ENOENT). */
export class AgentBackendNotInstalledError extends Schema.TaggedErrorClass<AgentBackendNotInstalledError>()(
  "AgentBackendNotInstalledError",
  {
    message: Schema.String,
    backend: AgentBackendDescriptorSchema,
    binary: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const isAgentBackendNotInstalledError = (
  value: unknown,
): value is AgentBackendNotInstalledError =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === "AgentBackendNotInstalledError"

/**
 * Walk a nested `cause` / `_tag` chain for AgentBackendNotInstalledError.
 * Step handlers wrap the spawn error, so `instanceof` on the top-level
 * failure is not enough.
 */
export const findAgentBackendNotInstalledError = (
  cause: unknown,
): AgentBackendNotInstalledError | undefined => {
  const seen = new Set<unknown>()
  let current: unknown = cause
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current)
    if (isAgentBackendNotInstalledError(current)) {
      return current
    }
    if (typeof current === "object" && "cause" in current) {
      current = Reflect.get(current, "cause")
      continue
    }
    break
  }
  return undefined
}

const isAgentBackendExitError = (
  value: unknown,
): value is AgentBackendExitError =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === "AgentBackendExitError"

/**
 * Walk a nested `cause` / `_tag` chain for AgentBackendExitError. Step
 * handlers wrap the spawn error, so `instanceof` on the top-level failure
 * is not enough.
 */
export const findAgentBackendExitError = (
  cause: unknown,
): AgentBackendExitError | undefined => {
  const seen = new Set<unknown>()
  let current: unknown = cause
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current)
    if (isAgentBackendExitError(current)) {
      return current
    }
    if (typeof current === "object" && "cause" in current) {
      current = Reflect.get(current, "cause")
      continue
    }
    break
  }
  return undefined
}
