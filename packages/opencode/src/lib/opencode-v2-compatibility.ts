/**
 * Supported OpenCode V2 client/server policy.
 *
 * The HTTP API is experimental. This package talks to it only through
 * `@opencode/client` 2.x and accepts only an OpenCode 2.x server. There is no
 * V1 SQLite or `opencode db path` fallback. A server that does not meet this
 * policy is a persistent compatibility failure, not a transient retry.
 *
 * Accounting: Session Telemetry uses `GET /api/session/{sessionID}`
 * `Session.Info` (model, variant as Thinking Level, token rollup including
 * reasoning and cache, cost, created/updated). That rollup matches the V2
 * session record. Summing currently listed assistant messages under-counts
 * compacted or omitted history, so message totals are not used. Child sessions
 * are separate records and are not rolled into the parent. Agent Turn Tail and
 * startup task detection read bounded message pages and exclude tool payloads
 * and child-session transcripts.
 */

export const OPENCODE_V2_CLIENT_PACKAGE = "@opencode/client" as const

/** Major line this package is generated and tested against. */
export const OPENCODE_V2_SUPPORTED_MAJOR = 2 as const

export const OPENCODE_V2_REQUIRED_OPERATIONS = [
  "server.info",
  "session.get",
  "session.list",
  "session.message.list",
] as const

export const OPENCODE_V2_TRANSIENT_DIAGNOSTIC =
  "OpenCode Session Telemetry is temporarily unavailable. Retry in a moment."

export const OPENCODE_V2_SERVICE_MISSING_DIAGNOSTIC =
  "OpenCode service is not running. Session Telemetry uses the same local service as agent execution and does not start it. Start OpenCode, or configure an explicit server, then Retry."

export const OPENCODE_V2_AUTHENTICATION_DIAGNOSTIC =
  "OpenCode rejected Session Telemetry authentication. This is not a transient outage. Use the same OpenCode service credentials as agent execution, then Retry."

export const openCodeV2IncompatibleDiagnostic = (version: string): string =>
  `OpenCode server ${version} is not a supported V2 API. Supported servers are OpenCode 2.x compatible with ${OPENCODE_V2_CLIENT_PACKAGE} 2.x. This is a compatibility failure, not a transient outage. There is no V1 fallback.`

export const OPENCODE_V2_MALFORMED_DIAGNOSTIC =
  "OpenCode returned a response that does not match the supported V2 contract. This is a compatibility failure, not a transient outage. There is no V1 fallback."

export const isSupportedOpenCodeServerVersion = (version: string): boolean => {
  const match = /(?:^|\s)v?(\d+)\.\d+\.\d+/.exec(version.trim())
  if (match === null) {
    return false
  }
  return Number(match[1]) === OPENCODE_V2_SUPPORTED_MAJOR
}

export type OpencodeUnavailablePersistence = "transient" | "persistent"

export type OpencodeUnavailable = {
  readonly kind: "unavailable"
  readonly persistence: OpencodeUnavailablePersistence
  readonly diagnostic: string
}

export type OpencodeReadFailure =
  | { readonly kind: "missing" }
  | OpencodeUnavailable

export const transientFailure = (
  diagnostic: string = OPENCODE_V2_TRANSIENT_DIAGNOSTIC,
): OpencodeUnavailable => ({
  kind: "unavailable",
  persistence: "transient",
  diagnostic,
})

export const persistentFailure = (diagnostic: string): OpencodeUnavailable => ({
  kind: "unavailable",
  persistence: "persistent",
  diagnostic,
})

const errorTag = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) {
    return undefined
  }
  if ("_tag" in error && typeof error._tag === "string") {
    return error._tag
  }
  if ("name" in error && typeof error.name === "string") {
    return error.name
  }
  return undefined
}

const clientReason = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("reason" in error)) {
    return undefined
  }
  return typeof error.reason === "string" ? error.reason : undefined
}

/**
 * Map a thrown OpenCode client or transport error. Does not include the raw
 * message: it can carry URLs or credential material.
 */
export const classifyOpencodeReadError = (
  error: unknown,
): OpencodeReadFailure => {
  const tag = errorTag(error)
  if (tag === "SessionNotFoundError") {
    return { kind: "missing" }
  }
  if (tag === "UnauthorizedError") {
    return persistentFailure(OPENCODE_V2_AUTHENTICATION_DIAGNOSTIC)
  }
  if (tag === "ClientError" && clientReason(error) === "MalformedResponse") {
    return persistentFailure(OPENCODE_V2_MALFORMED_DIAGNOSTIC)
  }
  if (tag === "AbortError" || tag === "TimeoutError") {
    return transientFailure()
  }
  return transientFailure()
}
