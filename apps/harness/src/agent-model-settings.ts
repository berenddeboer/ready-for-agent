/**
 * Settings helpers for Agent Model fields (Harness Config + Repository prefs).
 *
 * Claude Code allows free-text model ids (Bedrock inference profile IDs/ARNs
 * or any Claude-accepted `--model` string) in addition to the static alias
 * catalog. Other backends stay catalog-constrained at Save (issue #806 / #805).
 *
 * Effort levels are a local literal (not imported from `@ready-for-agent/claude`)
 * so this client-shared module stays free of the Claude adapter barrel.
 */

export type AgentModelOption = {
  readonly id: string
  readonly thinkingLevels: readonly string[]
}

/** Built-in Claude Code backend id (matches Active Agent Backend registry). */
export const CLAUDE_AGENT_BACKEND_ID = "claude"

/**
 * Effort (thinking) options for Claude free-text models — same set as aliases
 * (ADR 0047: low … max, no ultracode). Keep in lockstep with
 * `CLAUDE_THINKING_LEVELS` in packages/claude (asserted in unit tests).
 */
export const CLAUDE_FREE_TEXT_THINKING_LEVELS: readonly string[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]

/** True when Settings may accept non-catalog model strings for this backend. */
export const allowsClaudeFreeTextModels = (backendId: string): boolean =>
  backendId === CLAUDE_AGENT_BACKEND_ID

/**
 * Thinking Levels for a selected model id. Catalog membership wins when the
 * catalog is loaded; Claude free-text (and Claude while the catalog is still
 * pending/failed) falls back to the full Claude effort catalog so operators
 * can set effort the same way as aliases without waiting on inspect. Other
 * backends return [] when the model is unknown or the catalog is unavailable.
 */
export const thinkingLevelsForModel = (
  backendId: string,
  models: readonly AgentModelOption[] | undefined,
  modelId: string,
): readonly string[] => {
  if (modelId.length === 0) {
    return []
  }
  if (models !== undefined) {
    const fromCatalog = models.find(
      (model) => model.id === modelId,
    )?.thinkingLevels
    if (fromCatalog !== undefined) {
      return fromCatalog
    }
  }
  // Claude free-text effort is static (ADR 0047 / #806) — do not gate it on a
  // loaded catalog. Also covers Claude aliases while preview/models is pending.
  if (allowsClaudeFreeTextModels(backendId)) {
    return CLAUDE_FREE_TEXT_THINKING_LEVELS
  }
  return []
}

/**
 * True when a non-empty model string is absent from the loaded catalog and the
 * backend does not allow free-text. Used to block Save and hide effort.
 */
export const isUnavailableCatalogModel = (input: {
  readonly backendId: string
  readonly modelId: string
  readonly catalogModelIds: readonly string[]
}): boolean =>
  input.modelId.length > 0 &&
  !input.catalogModelIds.includes(input.modelId) &&
  !allowsClaudeFreeTextModels(input.backendId)

export const formatVariantLabel = (variant: string): string =>
  `${variant[0]?.toUpperCase() ?? ""}${variant.slice(1)}`

export const reconcileVariantForModel = (
  variant: string,
  modelVariants: readonly string[],
): string =>
  variant.length > 0 && modelVariants.includes(variant) ? variant : ""
