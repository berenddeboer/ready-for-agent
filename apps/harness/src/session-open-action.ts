/**
 * Which session action the operator gets.
 *
 * OpenCode with a resolvable server opens that session from the usage dialog.
 * Other backends, and OpenCode without a session id or server address, keep
 * the Agent Turn Tail fallback when the backend can serve one.
 */

export type SessionOpenAction =
  | { readonly kind: "open-in-opencode" }
  | { readonly kind: "tail" }
  | { readonly kind: "none" }

export const sessionOpenAction = (input: {
  readonly canOpenInOpenCode?: boolean
  readonly sessionId?: string | null
  readonly agentTurnTailSupported?: boolean
}): SessionOpenAction => {
  if (input.canOpenInOpenCode === true) return { kind: "open-in-opencode" }
  const sessionId = input.sessionId?.trim() ?? ""
  if (input.agentTurnTailSupported === true && sessionId.length > 0) {
    return { kind: "tail" }
  }
  return { kind: "none" }
}
