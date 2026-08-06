/**
 * Settings helpers for Agent Model fields (Harness Config + Repository prefs).
 *
 * First-party Claude Code allows free-text model ids (any Claude-accepted
 * `--model` string) in addition to the static alias catalog (issue #806).
 * Claude Code Bedrock configuration mode (`configurationMode === "bedrock"`,
 * from harness process `CLAUDE_CODE_USE_BEDROCK=1`) uses a strict select of
 * discovered inference profiles only — free-text is disabled (issue #828).
 * Other backends stay catalog-constrained at Save.
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
 * GraphQL `AgentBackendInfo.configurationMode` for Claude Code Bedrock.
 * Keep equal to agent-backend `CLAUDE_CODE_BEDROCK_CONFIGURATION_MODE`.
 */
export const CLAUDE_BEDROCK_CONFIGURATION_MODE = "bedrock"

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

/**
 * True when Settings may accept non-catalog model strings for this backend.
 * First-party Claude Code allows free-text; Claude Code Bedrock mode does not
 * (issue #828). Other backends never allow free-text.
 */
export const allowsClaudeFreeTextModels = (
  backendId: string,
  configurationMode?: string | null,
): boolean =>
  backendId === CLAUDE_AGENT_BACKEND_ID &&
  configurationMode !== CLAUDE_BEDROCK_CONFIGURATION_MODE

/**
 * True when Claude Code is in Bedrock configuration mode (strict profile
 * select, no free-text). Mode comes from GraphQL agentBackends metadata.
 */
export const isClaudeBedrockConfigurationMode = (
  backendId: string,
  configurationMode?: string | null,
): boolean =>
  backendId === CLAUDE_AGENT_BACKEND_ID &&
  configurationMode === CLAUDE_BEDROCK_CONFIGURATION_MODE

/**
 * Thinking Levels for a selected model id. Catalog membership wins when the
 * catalog is loaded; first-party Claude free-text (and first-party Claude while
 * the catalog is still pending/failed) falls back to the full Claude effort
 * catalog so operators can set effort the same way as aliases without waiting
 * on inspect. Bedrock mode and other backends return [] when the model is
 * unknown or the catalog is unavailable.
 */
export const thinkingLevelsForModel = (
  backendId: string,
  models: readonly AgentModelOption[] | undefined,
  modelId: string,
  configurationMode?: string | null,
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
  // Bedrock mode is catalog-only (#828).
  if (allowsClaudeFreeTextModels(backendId, configurationMode)) {
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
  readonly configurationMode?: string | null
}): boolean =>
  input.modelId.length > 0 &&
  !input.catalogModelIds.includes(input.modelId) &&
  !allowsClaudeFreeTextModels(input.backendId, input.configurationMode)

/**
 * Whether Bedrock-mode Settings must block Save for the current catalog/model
 * state. Loading, failed/empty discovery, missing selection, and values absent
 * from the catalog all block. First-party Claude and other backends return
 * false from this helper (they use their own Save gates).
 */
export const blocksClaudeBedrockModelSave = (input: {
  readonly backendId: string
  readonly configurationMode?: string | null
  /** Catalog is still loading (inspect/preview pending). */
  readonly catalogLoading: boolean
  /**
   * True when the catalog query/preview failed (distinct from still loading).
   * Blocks Save with a Recheck-oriented reason.
   */
  readonly catalogFailed?: boolean
  /**
   * Loaded catalog when known. `undefined` means not yet available (treat as
   * loading when {@link catalogLoading} is true, or as failed when
   * {@link catalogFailed} is true). Empty array = no profiles.
   */
  readonly catalogModels: readonly AgentModelOption[] | undefined
  /** Build (or required) model field value. */
  readonly modelId: string
  /**
   * When false, an empty modelId does not block (Repository inherit empty is
   * allowed). Harness Config requires a selection in Bedrock mode.
   */
  readonly requireSelection: boolean
}): boolean => {
  if (
    !isClaudeBedrockConfigurationMode(input.backendId, input.configurationMode)
  ) {
    return false
  }
  if (input.catalogFailed === true) {
    return true
  }
  if (input.catalogLoading || input.catalogModels === undefined) {
    return true
  }
  if (input.catalogModels.length === 0) {
    return true
  }
  if (input.modelId.length === 0) {
    return input.requireSelection
  }
  return isUnavailableCatalogModel({
    backendId: input.backendId,
    modelId: input.modelId,
    catalogModelIds: input.catalogModels.map((model) => model.id),
    configurationMode: input.configurationMode,
  })
}

/**
 * Operator-facing explanation when Bedrock model Save is blocked. Null when
 * Save is allowed for the model field.
 */
export const claudeBedrockModelSaveBlockReason = (input: {
  readonly backendId: string
  readonly configurationMode?: string | null
  readonly catalogLoading: boolean
  readonly catalogFailed?: boolean
  readonly catalogModels: readonly AgentModelOption[] | undefined
  readonly modelId: string
  readonly requireSelection: boolean
  /** Non-fatal discovery warnings from inspect/preview (already secret-safe). */
  readonly discoveryWarnings?: readonly string[]
}): string | null => {
  if (
    !blocksClaudeBedrockModelSave({
      backendId: input.backendId,
      configurationMode: input.configurationMode,
      catalogLoading: input.catalogLoading,
      catalogFailed: input.catalogFailed,
      catalogModels: input.catalogModels,
      modelId: input.modelId,
      requireSelection: input.requireSelection,
    })
  ) {
    return null
  }
  if (input.catalogFailed === true) {
    return "Could not load the Bedrock profile catalog. Recheck Agent Backend after fixing network or AWS configuration."
  }
  if (input.catalogLoading || input.catalogModels === undefined) {
    return "Loading Bedrock inference profiles… Save is blocked until the catalog is ready."
  }
  if (input.catalogModels.length === 0) {
    const warning = input.discoveryWarnings?.find(
      (entry) => entry.trim().length > 0,
    )
    if (warning !== undefined) {
      return `${warning} Choose a discovered profile after fixing AWS configuration and using Recheck Agent Backend.`
    }
    return "No active Anthropic-backed Bedrock inference profiles were found for the resolved AWS region. Fix AWS configuration, then Recheck Agent Backend."
  }
  if (input.modelId.length === 0) {
    return "Select a discovered Bedrock inference profile before saving."
  }
  return "The selected model is not in the current Bedrock profile catalog. Choose a discovered profile before saving."
}

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
