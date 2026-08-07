import type { AgentBackendErrorClassification } from "@ready-for-agent/agent-backend"

/**
 * Error names OpenCode's `error` stream event carries when a provider call
 * fails outright (`opencode run --format json`), matching the SDK's
 * `AssistantMessage["error"]["name"]` union. `UnknownError` is deliberately
 * excluded from every set below: it is OpenCode's own catch-all for an
 * unrecognized failure, so it falls back to generic classification.
 */
const LENGTH_LIMIT_ERROR_NAMES = new Set([
  "MessageOutputLengthError",
  "ContextOverflowError",
])
const TERMINAL_AUTH_ERROR_NAMES = new Set(["ProviderAuthError"])

/**
 * `isRetryable: false` on an `APIError` means the provider itself said this
 * exact call will not succeed on retry (bad request, quota exhausted).
 * 5xx and 429 are treated as retryable regardless of that flag, matching how
 * OpenCode's own retry policy (`session/retry.ts`) treats transient server
 * failures the provider SDK didn't explicitly mark.
 */
const isRetryableApiErrorData = (data: unknown): boolean => {
  if (typeof data !== "object" || data === null) {
    return false
  }
  if ("isRetryable" in data && data.isRetryable === true) {
    return true
  }
  if ("statusCode" in data && typeof data.statusCode === "number") {
    return data.statusCode === 429 || data.statusCode >= 500
  }
  return false
}

const classifyErrorEvent = (
  event: Record<string, unknown>,
): AgentBackendErrorClassification | undefined => {
  const error = event.error
  if (typeof error !== "object" || error === null || !("name" in error)) {
    return undefined
  }
  const name = error.name
  if (typeof name !== "string") {
    return undefined
  }

  if (LENGTH_LIMIT_ERROR_NAMES.has(name)) {
    return "length_limit_truncation"
  }

  if (TERMINAL_AUTH_ERROR_NAMES.has(name)) {
    return "terminal_auth_error"
  }

  if (name === "APIError") {
    const data = "data" in error ? error.data : undefined
    return isRetryableApiErrorData(data)
      ? "retryable_provider_error"
      : undefined
  }

  return undefined
}

/**
 * A `step_finish` part's `reason` truncated by the model's own output/context
 * limit rather than a natural stop. Mirrors the Vercel AI SDK `FinishReason`
 * OpenCode forwards verbatim onto `step-finish` parts.
 */
const classifyStepFinishEvent = (
  event: Record<string, unknown>,
): AgentBackendErrorClassification | undefined => {
  const part = event.part
  if (typeof part !== "object" || part === null || !("reason" in part)) {
    return undefined
  }
  return part.reason === "length" ? "length_limit_truncation" : undefined
}

/**
 * Recognize an OpenCode JSONL stream line as a classified provider error, so
 * `AgentBackendExitError` can carry that classification instead of a generic
 * exit code when the turn goes on to fail. Two event shapes carry a
 * classifiable failure: a top-level `error` event (provider call failed) and
 * a `step_finish` part with `reason: "length"` (output truncated by a limit
 * while the turn otherwise completed the step).
 */
export const parseErrorClassificationFromLine = (
  line: string,
): AgentBackendErrorClassification | undefined => {
  const trimmed = line.trim()
  if (trimmed.length === 0) {
    return undefined
  }

  let event: unknown
  try {
    event = JSON.parse(trimmed)
  } catch {
    return undefined
  }

  if (typeof event !== "object" || event === null || !("type" in event)) {
    return undefined
  }

  if (event.type === "error") {
    return classifyErrorEvent(event as Record<string, unknown>)
  }

  if (event.type === "step_finish") {
    return classifyStepFinishEvent(event as Record<string, unknown>)
  }

  return undefined
}
