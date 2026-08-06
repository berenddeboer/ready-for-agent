/**
 * Operator-facing Active / Preview Agent Backend status wording (issue #819).
 *
 * Examples:
 * - `Claude Code · Amazon Bedrock · Ready`
 * - `Claude Code · First-party · Ready`
 * - `OpenCode · Ready` (no provider)
 * - `Claude Code · Amazon Bedrock · Default · Unavailable — …`
 */

export type AgentBackendStatusProviderLabel = {
  readonly id: string
  readonly label: string
}

export type FormatAgentBackendStatusLabelInput = {
  readonly backendLabel: string
  readonly kind: "READY" | "UNAVAILABLE" | "ready" | "unavailable"
  readonly provider?: AgentBackendStatusProviderLabel | null
  readonly isDefault?: boolean
  readonly previewing?: boolean
  readonly reason?: string | null
}

const readinessWord = (
  kind: FormatAgentBackendStatusLabelInput["kind"],
): "Ready" | "Unavailable" => {
  const normalized = kind.toUpperCase()
  return normalized === "READY" ? "Ready" : "Unavailable"
}

/**
 * Segments after the backend name (provider, Default, Ready/Unavailable, …).
 * Provider identity is included only when present — never reconstructed here.
 */
export const formatAgentBackendStatusTrail = (
  input: Omit<FormatAgentBackendStatusLabelInput, "backendLabel">,
): string => {
  const parts: string[] = []
  const providerLabel = input.provider?.label?.trim()
  if (providerLabel !== undefined && providerLabel.length > 0) {
    parts.push(providerLabel)
  }
  if (input.isDefault === true) {
    parts.push("Default")
  }
  parts.push(readinessWord(input.kind))
  if (input.previewing === true) {
    parts.push("Previewing selection")
  }
  let trail = parts.join(" · ")
  if (
    readinessWord(input.kind) === "Unavailable" &&
    input.reason != null &&
    input.reason.trim().length > 0
  ) {
    trail = `${trail} — ${input.reason.trim()}`
  }
  return trail.length > 0 ? ` · ${trail}` : ""
}

/**
 * Full Settings status line including the backend label.
 */
export const formatAgentBackendStatusLabel = (
  input: FormatAgentBackendStatusLabelInput,
): string =>
  `${input.backendLabel}${formatAgentBackendStatusTrail({
    kind: input.kind,
    provider: input.provider,
    isDefault: input.isDefault,
    previewing: input.previewing,
    reason: input.reason,
  })}`
