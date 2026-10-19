/**
 * Which session action the operator gets.
 *
 * OpenCode with a resolved server URL opens that session in OpenCode.
 * Other backends, and OpenCode without a session id or server address, keep
 * the Agent Turn Tail fallback when the backend can serve one.
 */

export type SessionOpenAction =
  | { readonly kind: "open-in-opencode"; readonly url: string }
  | { readonly kind: "tail" }
  | { readonly kind: "none" }

const httpUrl = (value: string): string | null => {
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  try {
    const url = new URL(trimmed)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    if (url.username.length > 0 || url.password.length > 0) return null
    return trimmed
  } catch {
    return null
  }
}

export const sessionOpenAction = (input: {
  readonly openInOpenCodeUrl?: string | null
  readonly sessionId?: string | null
  readonly agentTurnTailSupported?: boolean
}): SessionOpenAction => {
  const url =
    input.openInOpenCodeUrl === null || input.openInOpenCodeUrl === undefined
      ? null
      : httpUrl(input.openInOpenCodeUrl)
  if (url !== null) return { kind: "open-in-opencode", url }
  const sessionId = input.sessionId?.trim() ?? ""
  if (input.agentTurnTailSupported === true && sessionId.length > 0) {
    return { kind: "tail" }
  }
  return { kind: "none" }
}
