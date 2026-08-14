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

export const formatUserFacingError = (
  error: unknown,
  fallback = "Unknown error",
  maxLength?: number,
): string => {
  const finish = (value: string): string => {
    const cleaned = sanitizeUserFacingText(value, maxLength)
    return cleaned.length > 0 ? cleaned : fallback
  }

  if (typeof error === "string") {
    return finish(error)
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string" &&
    (error as { message: string }).message.trim().length > 0
  ) {
    return finish((error as { message: string }).message)
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof (error as { _tag: unknown })._tag === "string" &&
    (error as { _tag: string })._tag.trim().length > 0
  ) {
    return finish((error as { _tag: string })._tag)
  }
  if (typeof error === "number" || typeof error === "boolean") {
    return finish(String(error))
  }
  return fallback
}
