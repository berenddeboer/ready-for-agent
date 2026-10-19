import {
  type AgentBackendErrorClassification,
  extractProviderRetryAt,
} from "@ready-for-agent/agent-backend"

/**
 * Exact Codex capacity sentence from `CodexErrorDetails::ServerOverloaded`.
 * `codex exec --json` on the supported CLI keeps this message and drops
 * `codex_error_info`, so the sentence is the narrow fallback.
 */
export const CODEX_MODEL_AT_CAPACITY_MESSAGE =
  "Selected model is at capacity. Please try a different model."

export type CodexExecFailureClassification = {
  readonly classification?: AgentBackendErrorClassification
  readonly retryAt?: number
  /**
   * Structured provider discriminator when the exec event actually carried
   * one (`server_overloaded`, `rate_limit_exceeded`, …). Absent for the
   * message-only capacity fallback.
   */
  readonly providerCode?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** snake_case and camelCase protocol spellings share one discriminator. */
const canonicalize = (value: string): string =>
  value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase()

const SAFE_PROVIDER_CODE = /^[a-z][a-z0-9_]{0,63}$/

const asProviderCode = (value: string): string | undefined => {
  const code = canonicalize(value)
  return SAFE_PROVIDER_CODE.test(code) ? code : undefined
}

const RETRYABLE_CODES = new Set([
  "server_overloaded",
  "rate_limit_exceeded",
  "internal_server_error",
])

const AUTH_CODES = new Set(["unauthorized"])

/**
 * Explicit non-transient codes. These suppress the capacity-message fallback
 * so billing exhaustion or a bad request cannot become retryable because the
 * prose happens to mention capacity.
 */
const PERMANENT_CODES = new Set(["usage_limit_exceeded", "bad_request"])

const readHttpStatus = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value >= 100 && value <= 599 ? value : undefined
  }
  if (!isRecord(value)) {
    return undefined
  }
  const raw = value.httpStatusCode ?? value.http_status_code
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    return undefined
  }
  return raw >= 100 && raw <= 599 ? raw : undefined
}

type StructuredCode = {
  readonly code: string
  readonly status?: number
}

/**
 * Unit variants are a string. Struct variants are a one-key object, which is
 * how app-server v2 serializes `httpConnectionFailed` and friends. Both
 * spellings are accepted; neither is required.
 */
const structuredFromValue = (value: unknown): StructuredCode | undefined => {
  if (typeof value === "string") {
    const code = asProviderCode(value)
    return code === undefined ? undefined : { code }
  }
  if (!isRecord(value)) {
    return undefined
  }
  const keys = Object.keys(value)
  if (keys.length !== 1) {
    return undefined
  }
  const key = keys[0]
  if (key === undefined) {
    return undefined
  }
  const code = asProviderCode(key)
  if (code === undefined) {
    return undefined
  }
  const status = readHttpStatus(value[key])
  return status === undefined ? { code } : { code, status }
}

const readStructured = (
  error: Record<string, unknown>,
): StructuredCode | undefined => {
  if ("codex_error_info" in error) {
    return structuredFromValue(error.codex_error_info)
  }
  if ("codexErrorInfo" in error) {
    return structuredFromValue(error.codexErrorInfo)
  }
  return undefined
}

const isCapacityMessage = (message: string): boolean => {
  const trimmed = message.trim()
  return (
    trimmed === CODEX_MODEL_AT_CAPACITY_MESSAGE ||
    trimmed.startsWith(`${CODEX_MODEL_AT_CAPACITY_MESSAGE} (`)
  )
}

const isTransientHttpStatus = (status: number | undefined): boolean =>
  status === 429 || (status !== undefined && status >= 500)

const isAuthHttpStatus = (status: number | undefined): boolean =>
  status === 401 || status === 403

const isOtherClientHttpStatus = (status: number | undefined): boolean =>
  status !== undefined && status >= 400 && status < 500 && status !== 429

/**
 * `http_connection_failed` without a status is ambiguous (a missing credential
 * is typed that way with 401). Stream disconnects are temporary unless the
 * status says otherwise.
 */
const classifyStructured = (
  structured: StructuredCode,
): AgentBackendErrorClassification | "permanent" | undefined => {
  if (AUTH_CODES.has(structured.code) || isAuthHttpStatus(structured.status)) {
    return "terminal_auth_error"
  }
  if (PERMANENT_CODES.has(structured.code)) {
    return "permanent"
  }
  if (RETRYABLE_CODES.has(structured.code)) {
    return "retryable_provider_error"
  }
  if (structured.code === "http_connection_failed") {
    return isTransientHttpStatus(structured.status)
      ? "retryable_provider_error"
      : "permanent"
  }
  if (
    structured.code === "response_stream_disconnected" ||
    structured.code === "response_stream_connection_failed" ||
    structured.code === "response_too_many_failed_attempts"
  ) {
    if (isOtherClientHttpStatus(structured.status)) {
      return "permanent"
    }
    return "retryable_provider_error"
  }
  return undefined
}

/**
 * Classify one Codex exec error object. Session rollout `task_complete`
 * events are not this shape; only fields that appear on the exec error
 * object are read.
 */
export const classifyCodexExecFailure = (input: {
  readonly error: unknown
  readonly now?: number
}): CodexExecFailureClassification => {
  const record = isRecord(input.error) ? input.error : undefined
  const message =
    record !== undefined && typeof record.message === "string"
      ? record.message
      : typeof input.error === "string"
        ? input.error
        : undefined
  const structured = record === undefined ? undefined : readStructured(record)
  const fromCode =
    structured === undefined ? undefined : classifyStructured(structured)
  const classification =
    fromCode === "permanent"
      ? undefined
      : (fromCode ??
        (message !== undefined && isCapacityMessage(message)
          ? "retryable_provider_error"
          : undefined))
  if (classification === undefined) {
    return structured !== undefined ? { providerCode: structured.code } : {}
  }
  const retryAt =
    classification === "retryable_provider_error" && record !== undefined
      ? extractProviderRetryAt({
          data: record,
          now: input.now ?? Date.now(),
        })
      : undefined
  return {
    classification,
    ...(retryAt !== undefined ? { retryAt } : {}),
    ...(structured !== undefined ? { providerCode: structured.code } : {}),
  }
}
