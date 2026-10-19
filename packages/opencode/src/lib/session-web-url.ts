/**
 * OpenCode V2 web UI session URL.
 *
 * Installed route (`opencode` 2.0.32): `/server/:serverKey/session/:id`.
 * `serverKey` is URL-safe base64 of the normalized server base, without
 * padding — the same encoding as the web UI's `sessionHref`.
 */

const TRAILING_SLASHES = /\/+$/

export const normalizeOpenCodeServerBase = (
  serverBase: string,
): string | null => {
  const trimmed = serverBase.trim().replace(TRAILING_SLASHES, "")
  if (trimmed.length === 0) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null
  if (url.username.length > 0 || url.password.length > 0) return null
  return trimmed
}

/** URL-safe base64 of the server base, without padding. */
export const encodeOpenCodeServerKey = (serverBase: string): string =>
  Buffer.from(serverBase, "utf8").toString("base64url")

/**
 * `<server-base>/server/<base64url(server-base)>/session/<encoded-session-id>`.
 * Null when the server base or session id cannot form a browser URL.
 * The result contains no credentials or pairing token.
 */
export const openCodeSessionWebUrl = (input: {
  readonly serverBase: string
  readonly sessionId: string
}): string | null => {
  const serverBase = normalizeOpenCodeServerBase(input.serverBase)
  const sessionId = input.sessionId.trim()
  if (serverBase === null || sessionId.length === 0) return null
  const serverKey = encodeOpenCodeServerKey(serverBase)
  return `${serverBase}/server/${serverKey}/session/${encodeURIComponent(sessionId)}`
}
