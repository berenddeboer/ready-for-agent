/**
 * OpenCode V2 telemetry read policy.
 *
 * Session Telemetry talks to the experimental HTTP API through
 * `@opencode/client`. A server version string is not proof of API
 * compatibility, so connection does not accept or reject a server from that
 * string and does not probe compatibility before a telemetry read. Startup
 * and discovery failures stay transient. There is no V1 SQLite or
 * `opencode db path` read.
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

export const OPENCODE_V2_MALFORMED_DIAGNOSTIC =
  "OpenCode returned a response that does not match the session data the harness can read. This is not a transient outage."

type OpencodeUnavailablePersistence = "transient" | "persistent"

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
