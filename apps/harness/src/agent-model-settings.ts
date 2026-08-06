/**
 * Settings helpers for Agent Model fields (Harness Config + Repository prefs).
 *
 * Claude Code allows free-text model ids (Bedrock inference profile IDs/ARNs
 * or any Claude-accepted `--model` string) in addition to the static alias
 * catalog. Other backends stay catalog-constrained at Save (issue #806 / #805).
 *
 * Bedrock catalog entries may carry optional operator-facing `name` and `kind`
 * while the executable persisted value remains `id` (issue #821).
 *
 * Effort levels are a local literal (not imported from `@ready-for-agent/claude`)
 * so this client-shared module stays free of the Claude adapter barrel.
 */

export type AgentModelOption = {
  /** Executable value stored in Settings and passed to the Agent Backend. */
  readonly id: string
  readonly thinkingLevels: readonly string[]
  /** Optional friendly display name (distinct from the persisted id). */
  readonly name?: string | null
  /** Optional kind metadata (e.g. SYSTEM_DEFINED / APPLICATION). */
  readonly kind?: string | null
}

/** Built-in Claude Code backend id (matches Active Agent Backend registry). */
export const CLAUDE_AGENT_BACKEND_ID = "claude"

/**
 * Bedrock system-defined inference profile kind (AgentModel.kind).
 * Keep equal to the Claude adapter's `BEDROCK_PROFILE_KIND_SYSTEM_DEFINED`
 * transport value (`SYSTEM_DEFINED`) — harness must not import the adapter.
 */
export const AGENT_MODEL_KIND_SYSTEM_DEFINED = "SYSTEM_DEFINED"

/**
 * Bedrock application inference profile kind (AgentModel.kind).
 * Keep equal to the Claude adapter's `BEDROCK_PROFILE_KIND_APPLICATION`
 * transport value (`APPLICATION`) — harness must not import the adapter.
 */
export const AGENT_MODEL_KIND_APPLICATION = "APPLICATION"

/**
 * Operator-facing kind label for catalog presentation. Null when kind is
 * absent or unrecognized (other backends omit kind).
 */
export const formatAgentModelKindLabel = (
  kind: string | null | undefined,
): string | null => {
  if (kind === AGENT_MODEL_KIND_SYSTEM_DEFINED) {
    return "System"
  }
  if (kind === AGENT_MODEL_KIND_APPLICATION) {
    return "Application"
  }
  const trimmed = kind?.trim() ?? ""
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Present a catalog entry so operators see a friendly name and profile type
 * while still knowing the exact executable id/ARN that Settings will store.
 *
 * Examples:
 * - `US Anthropic Claude Sonnet 4.6 · System · us.anthropic.claude-sonnet-4-6`
 * - `My Org Sonnet · Application · arn:aws:bedrock:…:application-inference-profile/…`
 * - plain `haiku` when no name/kind metadata is present
 */
export const formatAgentModelLabel = (model: AgentModelOption): string => {
  const name = model.name?.trim() ?? ""
  const kindLabel = formatAgentModelKindLabel(model.kind)
  const parts: string[] = []
  if (name.length > 0 && name !== model.id) {
    parts.push(name)
  }
  if (kindLabel !== null) {
    parts.push(kindLabel)
  }
  if (parts.length === 0) {
    return model.id
  }
  return `${parts.join(" · ")} · ${model.id}`
}

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

/**
 * Find a catalog entry by executable id. Used to label free-text inputs when
 * the current value is a discovered profile rather than a pure custom string.
 */
export const findCatalogModel = (
  models: readonly AgentModelOption[] | undefined,
  modelId: string,
): AgentModelOption | undefined => {
  if (modelId.length === 0 || models === undefined) {
    return undefined
  }
  return models.find((model) => model.id === modelId)
}

/**
 * True when a non-empty model string is known to be absent from a **loaded**
 * catalog. Returns false while the catalog is still pending (`undefined`) so
 * Settings does not flash “custom” for saved values that may yet match
 * (issue #821 review).
 */
export const isCustomAgentModelValue = (input: {
  readonly models: readonly AgentModelOption[] | undefined
  readonly modelId: string
}): boolean =>
  input.models !== undefined &&
  input.modelId.length > 0 &&
  findCatalogModel(input.models, input.modelId) === undefined
