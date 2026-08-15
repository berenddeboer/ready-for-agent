import {
  formatUserFacingError,
  sanitizeUserFacingText,
} from "./user-facing-error.js"

/** One link in a nested `cause` chain, for structured logs and Step Run detail. */
export type CauseChainLink = {
  readonly name?: string
  readonly code?: string
  readonly message?: string
}

/** Durable diagnostic payload stored on `step_run.reason_detail`. */
export type StepRunReasonDetail = {
  readonly causeChain: readonly CauseChainLink[]
  readonly code?: string
  /**
   * Trustworthy provider retry instant as ISO-8601, when the Agent Backend
   * adapter extracted one from a quota or rate-limit failure.
   */
  readonly retryAt?: string
}

const DEFAULT_MAX_DEPTH = 8
const LINK_MESSAGE_MAX = 500

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null

const readString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const readRetryAtIso = (value: unknown): string | undefined => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
  }
  return undefined
}

const readCode = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value)
  }
  return undefined
}

const linkFromValue = (value: unknown): CauseChainLink | null => {
  if (typeof value === "string") {
    const message = sanitizeUserFacingText(value, LINK_MESSAGE_MAX)
    return message.length > 0 ? { message } : null
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return { message: String(value) }
  }

  const record = asRecord(value)
  if (record === null) return null

  const name =
    readString(record.name) ??
    (typeof record._tag === "string" ? readString(record._tag) : undefined)
  // Effect TimeoutError has no numeric/string code field; treat the tag as the
  // machine-readable discriminator so logs and Step Runs can group timeouts.
  const code =
    readCode(record.code) ??
    readCode(record.exitCode) ??
    (name === "TimeoutError" ? "TIMEOUT" : undefined)
  const rawMessage = readString(record.message)
  const message =
    rawMessage === undefined
      ? undefined
      : sanitizeUserFacingText(rawMessage, LINK_MESSAGE_MAX)

  if (name === undefined && code === undefined && message === undefined) {
    return null
  }

  return {
    ...(name !== undefined ? { name } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(message !== undefined && message.length > 0 ? { message } : {}),
  }
}

const nextCause = (value: unknown): unknown => {
  const record = asRecord(value)
  if (record === null) return undefined
  if ("cause" in record && record.cause !== undefined) {
    return record.cause
  }
  // AggregateError and similar multi-cause carriers.
  if (Array.isArray(record.errors) && record.errors.length > 0) {
    return record.errors[0]
  }
  return undefined
}

const extractRetryAtIso = (error: unknown): string | undefined => {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current)
    const record = asRecord(current)
    if (record !== null && "retryAt" in record) {
      const retryAt = readRetryAtIso(record.retryAt)
      if (retryAt !== undefined) {
        return retryAt
      }
    }
    current = nextCause(current)
  }
  return undefined
}

/**
 * Flatten nested `cause` / AggregateError chains into structured links.
 * Does not produce a formatted blob — each link keeps `name` / `code` / `message`.
 */
export const extractCauseChain = (
  error: unknown,
  maxDepth = DEFAULT_MAX_DEPTH,
): readonly CauseChainLink[] => {
  const chain: CauseChainLink[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  let depth = 0

  while (
    current !== undefined &&
    current !== null &&
    depth < maxDepth &&
    !seen.has(current)
  ) {
    seen.add(current)
    const link = linkFromValue(current)
    if (link !== null) {
      chain.push(link)
    }
    current = nextCause(current)
    depth += 1
  }

  return chain
}

/** First machine-readable `code` found walking the cause chain. */
export const extractErrorCode = (error: unknown): string | undefined => {
  for (const link of extractCauseChain(error)) {
    if (link.code !== undefined) {
      return link.code
    }
  }
  return undefined
}

export const buildReasonDetail = (
  error: unknown,
): StepRunReasonDetail | null => {
  const causeChain = extractCauseChain(error)
  const code = extractErrorCode(error)
  const retryAt = extractRetryAtIso(error)
  if (causeChain.length === 0 && code === undefined && retryAt === undefined) {
    return null
  }
  return {
    causeChain,
    ...(code !== undefined ? { code } : {}),
    ...(retryAt !== undefined ? { retryAt } : {}),
  }
}

export const serializeReasonDetail = (
  detail: StepRunReasonDetail | null,
): string | null => (detail === null ? null : JSON.stringify(detail))

/**
 * Read path for `step_run.reason_detail`. Re-sanitizes each stored message so
 * display surfaces do not become a second disclosure path for helper text.
 */
export const parseReasonDetail = (
  raw: string | null | undefined,
): StepRunReasonDetail | null => {
  if (raw === null || raw === undefined) return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }

  const record = asRecord(parsed)
  if (record === null) return null

  const causeChain: CauseChainLink[] = []
  if (Array.isArray(record.causeChain)) {
    for (const item of record.causeChain) {
      const link = linkFromValue(item)
      if (link !== null) {
        causeChain.push(link)
      }
    }
  }

  const code = readCode(record.code)
  const retryAt = readRetryAtIso(record.retryAt)
  if (causeChain.length === 0 && code === undefined && retryAt === undefined) {
    return null
  }
  return {
    causeChain,
    ...(code !== undefined ? { code } : {}),
    ...(retryAt !== undefined ? { retryAt } : {}),
  }
}

/**
 * Structured log annotations for a failure: short human `error` plus
 * `causeChain` / optional `code` so operators can distinguish TLS, auth,
 * timeout, and transport failures without prose parsing.
 */
export const logErrorAnnotations = (
  error: unknown,
  fallback = "Unknown error",
): {
  readonly error: string
  readonly causeChain: readonly CauseChainLink[]
  readonly code?: string
} => {
  const causeChain = extractCauseChain(error)
  const code = extractErrorCode(error)
  return {
    error: formatUserFacingError(error, fallback),
    causeChain,
    ...(code !== undefined ? { code } : {}),
  }
}
