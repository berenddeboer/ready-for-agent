const ESC = String.fromCharCode(0x1b)
const CSI = String.fromCharCode(0x9b)
const ANSI_ESCAPE_RE = new RegExp(
  `[${ESC}${CSI}][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]`,
  "g",
)

const TOKEN_SHAPED_RE =
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bglpat-[A-Za-z0-9_-]{20,}\b|\bsk-ant-[A-Za-z0-9_-]{16,}\b|\bsk-[A-Za-z0-9]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi

/** Operator-visible exit reasons are persisted and rendered in a browser. */
const AGENT_BACKEND_EXIT_MESSAGE_MAX = 500

const cleanOperatorFacingText = (text: string): string =>
  text.replace(ANSI_ESCAPE_RE, "").replace(TOKEN_SHAPED_RE, "[redacted]").trim()

export const sanitizeAgentBackendExitMessage = (text: string): string =>
  cleanOperatorFacingText(text).slice(0, AGENT_BACKEND_EXIT_MESSAGE_MAX)

/**
 * Redact the full captured tail, then keep the most recent bound so a
 * token that would straddle a raw suffix cut is already gone.
 */
export const sanitizeAgentBackendStderrTail = (
  text: string,
): string | undefined => {
  const cleaned = cleanOperatorFacingText(text)
  if (cleaned.length === 0) {
    return undefined
  }
  return cleaned.length <= AGENT_BACKEND_EXIT_MESSAGE_MAX
    ? cleaned
    : cleaned.slice(-AGENT_BACKEND_EXIT_MESSAGE_MAX)
}
