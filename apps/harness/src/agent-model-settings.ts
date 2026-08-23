/**
 * Settings policy for Agent Model fields (Harness Config + Repository prefs).
 *
 * Agent Model selection is **catalog-only for every Agent Backend** (issue
 * #838). Settings never accepts a model string that is absent from the current
 * Ready catalog of the selected/effective Agent Backend — first-party Claude
 * Code offers its static aliases, Claude Code Bedrock offers discovered
 * inference profiles, and the other backends offer their own catalogs. This
 * supersedes the first-party free-text decision (issue #806) and keeps the
 * strict Bedrock decision (issue #828).
 *
 * A stored value that is no longer in the catalog is **preserved** (never
 * rewritten, translated between provider modes, or coerced to the first
 * catalog entry). Settings shows it as a visibly unavailable option next to the
 * current catalog and blocks Save until the operator picks a current model (or,
 * in Repository scope, clears the override to inherit).
 *
 * Bedrock catalog entries may carry optional operator-facing `name` and `kind`
 * while the executable persisted value remains `id` (issue #821).
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
 * - `opencode/x-preview-f-free (Ox Alpha Free (Unlimited))` — a name without
 *   kind metadata keeps the id first and appends the name in parentheses
 * - plain `haiku` when no name/kind metadata is present
 */
export const formatAgentModelLabel = (model: AgentModelOption): string => {
  const name = model.name?.trim() ?? ""
  const kindLabel = formatAgentModelKindLabel(model.kind)
  if (kindLabel === null) {
    if (name.length > 0 && name !== model.id) {
      return `${model.id} (${name})`
    }
    return model.id
  }
  const parts: string[] = []
  if (name.length > 0 && name !== model.id) {
    parts.push(name)
  }
  parts.push(kindLabel)
  return `${parts.join(" · ")} · ${model.id}`
}

/**
 * True when Claude Code is in Bedrock configuration mode. Mode comes from
 * GraphQL agentBackends metadata (never from browser process env) and only
 * selects operator guidance wording — catalog-only enforcement is identical
 * for every Agent Backend (issue #838).
 */
export const isClaudeBedrockConfigurationMode = (
  backendId: string,
  configurationMode?: string | null,
): boolean =>
  backendId === CLAUDE_AGENT_BACKEND_ID &&
  configurationMode === CLAUDE_BEDROCK_CONFIGURATION_MODE

/**
 * Find a catalog entry by executable id. Friendly names are presentation only
 * and are never a lookup key.
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
 * Thinking Levels for a selected model id, derived from the catalog entry.
 * Returns [] for an empty selection, an unknown model, or a catalog that has
 * not loaded — Settings then shows "no effort (thinking) options" rather than
 * inventing a level set (issue #838 removed the Claude free-text fallback).
 */
export const thinkingLevelsForModel = (
  models: readonly AgentModelOption[] | undefined,
  modelId: string,
): readonly string[] => findCatalogModel(models, modelId)?.thinkingLevels ?? []

/**
 * True when a non-empty model string is absent from the given catalog ids.
 * Catalog membership is required for every Agent Backend.
 */
export const isUnavailableCatalogModel = (input: {
  readonly modelId: string
  readonly catalogModelIds: readonly string[]
}): boolean =>
  input.modelId.length > 0 && !input.catalogModelIds.includes(input.modelId)

/** Catalog availability for one Settings model field. */
export type AgentModelCatalogState = {
  /** Catalog is still loading (models query / preview pending). */
  readonly catalogLoading: boolean
  /** Catalog query or preview failed (distinct from still loading). */
  readonly catalogFailed?: boolean
  /**
   * Loaded catalog when known. `undefined` means not yet available; an empty
   * array means the backend reported no models.
   */
  readonly catalogModels: readonly AgentModelOption[] | undefined
}

export type AgentModelSaveInput = AgentModelCatalogState & {
  /** Current field value ("" means unset / inherit). */
  readonly modelId: string
  /**
   * When false an empty value never blocks (Repository override inherits the
   * harness default). Harness Config requires a build model selection.
   */
  readonly requireSelection: boolean
}

/**
 * Whether Settings must block Save for this model field.
 *
 * An empty optional value is always fine (nothing to validate — inheritance
 * keeps working even without a healthy catalog). Any explicit value requires a
 * loaded, non-empty catalog that contains it: loading, failed, and empty
 * catalogs cannot establish membership, so they block rather than silently
 * accept a value that would only fail later at CLI time.
 */
export const blocksAgentModelSave = (input: AgentModelSaveInput): boolean => {
  if (input.modelId.length === 0 && !input.requireSelection) {
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
    return true
  }
  return isUnavailableCatalogModel({
    modelId: input.modelId,
    catalogModelIds: input.catalogModels.map((model) => model.id),
  })
}

export type AgentModelSaveReasonInput = AgentModelSaveInput & {
  /** Selected/effective backend id — selects operator guidance wording. */
  readonly backendId: string
  readonly configurationMode?: string | null
  /** Non-fatal discovery warnings from inspect/preview (already secret-safe). */
  readonly discoveryWarnings?: readonly string[]
}

/**
 * Operator-facing explanation when a model field blocks Save. Null when the
 * field is fine. Bedrock mode keeps its AWS-specific guidance (issue #828);
 * every other backend gets the equivalent catalog wording.
 */
export const agentModelSaveBlockReason = (
  input: AgentModelSaveReasonInput,
): string | null => {
  if (!blocksAgentModelSave(input)) {
    return null
  }
  const bedrock = isClaudeBedrockConfigurationMode(
    input.backendId,
    input.configurationMode,
  )
  if (input.catalogFailed === true) {
    return bedrock
      ? "Could not load the Bedrock profile catalog. Recheck Agent Backend after fixing network or AWS configuration."
      : "Could not load the Agent Model catalog. Recheck Agent Backend after fixing the Agent Backend configuration."
  }
  if (input.catalogLoading || input.catalogModels === undefined) {
    return bedrock
      ? "Loading Bedrock inference profiles… Save is blocked until the catalog is ready."
      : "Loading the Agent Model catalog… Save is blocked until the catalog is ready."
  }
  if (input.catalogModels.length === 0) {
    const warning = input.discoveryWarnings?.find(
      (entry) => entry.trim().length > 0,
    )
    if (warning !== undefined) {
      return `${warning} Choose a discovered profile after fixing AWS configuration and using Recheck Agent Backend.`
    }
    return bedrock
      ? "No active Anthropic-backed Bedrock inference profiles were found for the resolved AWS region. Fix AWS configuration, then Recheck Agent Backend."
      : "No Agent Models are available for this Agent Backend. Fix the Agent Backend configuration, then Recheck Agent Backend."
  }
  if (input.modelId.length === 0) {
    return bedrock
      ? "Select a discovered Bedrock inference profile before saving."
      : "Select a model from the Agent Model catalog before saving."
  }
  return bedrock
    ? "The selected model is not in the current Bedrock profile catalog. Choose a discovered profile before saving."
    : "The selected model is not in the current Agent Model catalog. Choose a listed model before saving."
}

/**
 * Catalog-state guidance independent of the current field value. Repository
 * overrides may be left empty (and saved) while a catalog is loading, failed,
 * or empty, so the dialog still explains why no options are selectable.
 */
export const agentModelCatalogNotice = (
  input: AgentModelCatalogState & {
    readonly backendId: string
    readonly configurationMode?: string | null
    readonly discoveryWarnings?: readonly string[]
  },
): string | null => {
  const catalogUsable =
    input.catalogFailed !== true &&
    !input.catalogLoading &&
    input.catalogModels !== undefined &&
    input.catalogModels.length > 0
  if (catalogUsable) {
    return null
  }
  // Report the catalog state only — never "select a model", which would be
  // wrong guidance for a field that is allowed to stay empty.
  return agentModelSaveBlockReason({
    ...input,
    modelId: "",
    requireSelection: true,
  })
}

export const formatVariantLabel = (variant: string): string =>
  `${variant[0]?.toUpperCase() ?? ""}${variant.slice(1)}`

/**
 * Label for a stored effort (thinking) level that the selected catalog entry
 * does not offer. The stored value is preserved and marked, never dropped
 * silently (issue #838).
 */
export const formatUnavailableVariantLabel = (variant: string): string =>
  `${formatVariantLabel(variant)} (not available for this model)`

export const reconcileVariantForModel = (
  variant: string,
  modelVariants: readonly string[],
): string =>
  variant.length > 0 && modelVariants.includes(variant) ? variant : ""

/**
 * Governing review Agent Model using the same fallback order as runtime
 * resolution (issue #1073): explicit review, then inherited Harness review,
 * then the resolved build model.
 */
export const governingReviewModelId = (input: {
  readonly reviewModel: string
  readonly harnessReviewModel?: string
  readonly resolvedBuildModel: string
}): string => {
  if (input.reviewModel.length > 0) {
    return input.reviewModel
  }
  if ((input.harnessReviewModel ?? "").length > 0) {
    return input.harnessReviewModel ?? ""
  }
  return input.resolvedBuildModel
}

export type ThinkingLevelSaveInput = AgentModelCatalogState & {
  /** Whether this stored Thinking Level contributes to the next resolved pair. */
  readonly applicable: boolean
  readonly thinkingLevel: string
  readonly governingModelId: string
}

/**
 * Block Save when an applicable non-null Thinking Level is not advertised by
 * the governing catalog entry. Dormant Repository levels do not block.
 */
export const blocksThinkingLevelSave = (
  input: ThinkingLevelSaveInput,
): boolean => {
  if (!input.applicable) {
    return false
  }
  const thinkingLevel = input.thinkingLevel.trim()
  if (thinkingLevel.length === 0) {
    return false
  }
  if (input.catalogFailed === true) {
    return true
  }
  if (input.catalogLoading || input.catalogModels === undefined) {
    return true
  }
  if (input.governingModelId.length === 0) {
    return false
  }
  const entry = findCatalogModel(input.catalogModels, input.governingModelId)
  if (entry === undefined) {
    return true
  }
  return !entry.thinkingLevels.includes(thinkingLevel)
}

export const thinkingLevelSaveBlockReason = (
  input: ThinkingLevelSaveInput,
): string | null =>
  blocksThinkingLevelSave(input)
    ? "The selected Thinking Level is not advertised by the governing Agent Model. Choose a listed level or clear the field before saving."
    : null

/**
 * Empty-option copy for a Thinking Level control. An explicit model means
 * backend/model default; an inherited complete Harness selection names that
 * selection; review-with-build fallback names the build selection.
 */
export const emptyThinkingLevelOptionLabel = (input: {
  readonly explicitModel: boolean
  readonly inheritedLabel?: string
  readonly fallsBackToBuild: boolean
}): string => {
  if (input.fallsBackToBuild) {
    const inherited = input.inheritedLabel?.trim() ?? ""
    if (inherited.length > 0) {
      return `Harness default (${inherited})`
    }
    return "Same as build effort (thinking)"
  }
  if (input.explicitModel) {
    return "Model default"
  }
  const inherited = input.inheritedLabel?.trim() ?? ""
  if (inherited.length > 0) {
    return `Harness default (${inherited})`
  }
  return "Model default"
}
