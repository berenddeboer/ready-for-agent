const ESC = String.fromCharCode(0x1b)
const CSI = String.fromCharCode(0x9b)
const ANSI_ESCAPE_RE = new RegExp(
  `[${ESC}${CSI}][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]`,
  "g",
)

export const stripAnsi = (text: string): string =>
  text.replace(ANSI_ESCAPE_RE, "")

const extractMessageFromInspectDump = (text: string): string | undefined => {
  if (!/_tag\s*:/.test(text)) {
    return undefined
  }
  const messageMatch = text.match(/message\s*:\s*"((?:\\.|[^"\\])*)"/)
  if (messageMatch?.[1] !== undefined && messageMatch[1].trim().length > 0) {
    return messageMatch[1]
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\")
  }
  const tagMatch = text.match(/_tag\s*:\s*"([^"]+)"/)
  if (tagMatch?.[1] !== undefined && tagMatch[1].trim().length > 0) {
    return tagMatch[1]
  }
  return undefined
}

const TOKEN_SHAPED_RE =
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bglpat-[A-Za-z0-9_-]{20,}\b|\bsk-ant-[A-Za-z0-9_-]{16,}\b|\bsk-[A-Za-z0-9]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi

export const sanitizeUserFacingText = (
  text: string,
  maxLength?: number,
): string => {
  let cleaned = stripAnsi(text).trim()
  const extracted = extractMessageFromInspectDump(cleaned)
  if (extracted !== undefined) {
    cleaned = extracted.trim()
  }
  cleaned = cleaned.replace(TOKEN_SHAPED_RE, "[redacted]")
  if (maxLength !== undefined) {
    cleaned = cleaned.slice(0, maxLength)
  }
  return cleaned
}

/** Operator-facing labels for statuses the board must distinguish. */
const HTTP_SHORT_CAUSE: Readonly<Record<number, string>> = {
  401: "Unauthorized",
  403: "Forbidden",
  409: "Conflict",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
}

const readProp = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined

const readHttpStatusCode = (value: unknown): number | undefined => {
  const status = readProp(value, "statusCode")
  if (
    typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
  ) {
    return status
  }
  return undefined
}

const httpStatusFromText = (text: string): number | undefined => {
  let fallback: number | undefined
  for (const match of text.matchAll(/\bHTTP\s+(\d{3})\b/gi)) {
    const status = Number(match[1])
    if (status >= 400 && status <= 599) {
      return status
    }
    if (fallback === undefined && status >= 100 && status <= 599) {
      fallback = status
    }
  }
  return fallback
}

const nextCause = (value: unknown): unknown => {
  const cause = readProp(value, "cause")
  if (cause !== undefined) {
    return cause
  }
  const errors = readProp(value, "errors")
  if (Array.isArray(errors) && errors.length > 0) {
    return errors[0]
  }
  return undefined
}

/**
 * Prefer the typed `statusCode` field, then `HTTP NNN` in messages or
 * postcondition `diagnostics`. Never copies nested response bodies.
 */
const extractHttpStatus = (error: unknown): number | undefined => {
  const seen = new Set<unknown>()
  let current: unknown = error
  let fromText: number | undefined
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current)
    const fromField = readHttpStatusCode(current)
    if (fromField !== undefined) {
      return fromField
    }
    if (fromText === undefined) {
      const message = readProp(current, "message")
      if (typeof message === "string") {
        fromText = httpStatusFromText(message)
      }
    }
    if (fromText === undefined) {
      const diagnostics = readProp(current, "diagnostics")
      if (typeof diagnostics === "string") {
        fromText = httpStatusFromText(diagnostics)
      }
    }
    current = nextCause(current)
  }
  return fromText
}

const httpSuffix = (status: number, message: string): string => {
  const label = `HTTP ${status}`
  if (message.includes(label)) {
    return ""
  }
  const cause = HTTP_SHORT_CAUSE[status]
  if (
    cause !== undefined &&
    !message.toLowerCase().includes(cause.toLowerCase())
  ) {
    return `: ${label} ${cause}`
  }
  return `: ${label}`
}

export const formatUserFacingError = (
  error: unknown,
  fallback = "Unknown error",
  maxLength?: number,
): string => {
  const finish = (value: string): string => {
    const base = sanitizeUserFacingText(value)
    const usable = base.length > 0 ? base : fallback
    const status = extractHttpStatus(error)
    const suffix = status === undefined ? "" : httpSuffix(status, usable)
    const combined = `${usable}${suffix}`
    if (maxLength === undefined || combined.length <= maxLength) {
      return combined
    }
    if (suffix.length === 0) {
      return combined.slice(0, maxLength)
    }
    const budget = Math.max(0, maxLength - suffix.length)
    return `${usable.slice(0, budget)}${suffix}`
  }

  if (typeof error === "string") {
    return finish(error)
  }
  const message = readProp(error, "message")
  if (typeof message === "string" && message.trim().length > 0) {
    return finish(message)
  }
  const tag = readProp(error, "_tag")
  if (typeof tag === "string" && tag.trim().length > 0) {
    return finish(tag)
  }
  if (typeof error === "number" || typeof error === "boolean") {
    return finish(String(error))
  }
  return fallback
}
