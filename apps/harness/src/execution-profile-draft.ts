import {
  type AgentModelCatalogState,
  type AgentModelOption,
  blocksAgentModelSave,
  isClaudeBedrockConfigurationMode,
  reconcileVariantForModel,
  thinkingLevelsForModel,
} from "./agent-model-settings.js"

/** Backend-scoped model fields shared by Repository settings and Harness Config. */
export type ExecutionProfilePrefSource = {
  readonly defaultModel: string | null
  readonly defaultThinkingLevel: string | null
  readonly reviewModel: string | null
  readonly reviewThinkingLevel: string | null
}

/**
 * Dialog draft for one Implement With attempt. Review is either Same as build
 * or an explicit review model; those two cannot both be true.
 */
export type ExecutionProfileDraft =
  | {
      readonly buildModel: string
      readonly buildThinkingLevel: string
      readonly reviewSameAsBuild: true
    }
  | {
      readonly buildModel: string
      readonly buildThinkingLevel: string
      readonly reviewSameAsBuild: false
      readonly reviewModel: string
      readonly reviewThinkingLevel: string
    }

const nonEmpty = (value: string | null | undefined): value is string =>
  value !== null && value !== undefined && value.trim() !== ""

const asField = (value: string | null | undefined): string =>
  nonEmpty(value) ? value : ""

/**
 * Pre-fill Implement With from currently resolved backend-scoped Repository
 * then Harness preferences. A missing build model stays blank. Review stays
 * Same as build unless an explicit review model is configured.
 */
export const resolveExecutionProfileDraft = (input: {
  readonly repository: ExecutionProfilePrefSource
  readonly harness: ExecutionProfilePrefSource
}): ExecutionProfileDraft => {
  const buildModel = nonEmpty(input.repository.defaultModel)
    ? input.repository.defaultModel
    : asField(input.harness.defaultModel)
  const buildThinkingLevel = nonEmpty(input.repository.defaultModel)
    ? asField(input.repository.defaultThinkingLevel)
    : asField(input.harness.defaultThinkingLevel)
  const explicitReview = nonEmpty(input.repository.reviewModel)
    ? {
        reviewModel: input.repository.reviewModel,
        reviewThinkingLevel: asField(input.repository.reviewThinkingLevel),
      }
    : nonEmpty(input.harness.reviewModel)
      ? {
          reviewModel: input.harness.reviewModel,
          reviewThinkingLevel: asField(input.harness.reviewThinkingLevel),
        }
      : null
  if (explicitReview === null) {
    return {
      buildModel,
      buildThinkingLevel,
      reviewSameAsBuild: true,
    }
  }
  return {
    buildModel,
    buildThinkingLevel,
    reviewSameAsBuild: false,
    reviewModel: explicitReview.reviewModel,
    reviewThinkingLevel: explicitReview.reviewThinkingLevel,
  }
}

/** GraphQL `implementWith` profile input. */
export type ImplementWithProfileInput = {
  readonly agentBackendId: string
  readonly buildModel: string
  readonly buildThinkingLevel: string | null
  readonly reviewSameAsBuild: boolean
  readonly reviewModel: string | null
  readonly reviewThinkingLevel: string | null
}

/** GraphQL `implementWith` options. The dialog always submits both values. */
type ImplementWithOptionsInput = {
  readonly autoMerge: boolean
  readonly implementLocally: boolean
}

export type ImplementWithSubmitInput = {
  readonly profile: ImplementWithProfileInput
  readonly options: ImplementWithOptionsInput
}

const emptyToNull = (value: string): string | null =>
  value.trim().length === 0 ? null : value

export const executionProfileInputFromDraft = (input: {
  readonly agentBackendId: string
  readonly draft: ExecutionProfileDraft
}): ImplementWithProfileInput => {
  if (input.draft.reviewSameAsBuild) {
    return {
      agentBackendId: input.agentBackendId,
      buildModel: input.draft.buildModel,
      buildThinkingLevel: emptyToNull(input.draft.buildThinkingLevel),
      reviewSameAsBuild: true,
      reviewModel: null,
      reviewThinkingLevel: null,
    }
  }
  return {
    agentBackendId: input.agentBackendId,
    buildModel: input.draft.buildModel,
    buildThinkingLevel: emptyToNull(input.draft.buildThinkingLevel),
    reviewSameAsBuild: false,
    reviewModel: emptyToNull(input.draft.reviewModel),
    reviewThinkingLevel: emptyToNull(input.draft.reviewThinkingLevel),
  }
}

type PreviewCatalogSnapshot = {
  readonly kind: string
  readonly models: readonly AgentModelOption[]
}

/** First READY catalog accepted for one Agent Backend in one dialog session. */
export type ImplementWithCatalogPin = {
  readonly models: readonly AgentModelOption[]
}

/**
 * Remember the first READY preview for this backend. Later previews — failed,
 * empty, Unavailable, or READY with a different list — do not replace it.
 */
export const nextImplementWithCatalogPin = (input: {
  readonly pin: ImplementWithCatalogPin | undefined
  readonly preview: PreviewCatalogSnapshot | undefined
}): ImplementWithCatalogPin | undefined => {
  if (input.pin !== undefined) {
    return input.pin
  }
  if (input.preview?.kind === "READY") {
    return { models: input.preview.models }
  }
  return undefined
}

/**
 * Withhold leftover query cache from a new dialog session until this observer
 * has fetched. An in-session pin may still see cached preview while a
 * backend switch-back refetches.
 */
export const implementWithSessionPreview = (input: {
  readonly pin: ImplementWithCatalogPin | undefined
  readonly preview: PreviewCatalogSnapshot | undefined
  readonly fetchedAfterMount: boolean
  readonly previewFailed: boolean
}): {
  readonly preview: PreviewCatalogSnapshot | undefined
  readonly previewFailed: boolean
} => {
  if (input.pin !== undefined || input.fetchedAfterMount) {
    return {
      preview: input.preview,
      previewFailed: input.previewFailed,
    }
  }
  return { preview: undefined, previewFailed: false }
}

/**
 * If a pin exists it is the catalog. Otherwise a READY preview is usable and
 * any other settled preview is empty/failed.
 */
export const usablePreviewCatalog = (input: {
  readonly preview: PreviewCatalogSnapshot | undefined
  readonly previewFailed: boolean
  readonly pin?: ImplementWithCatalogPin
}): {
  readonly models: readonly AgentModelOption[] | undefined
  readonly failed: boolean
} => {
  if (input.pin !== undefined) {
    return { models: input.pin.models, failed: false }
  }
  if (input.preview?.kind === "READY") {
    return { models: input.preview.models, failed: false }
  }
  if (input.preview === undefined) {
    return { models: undefined, failed: input.previewFailed }
  }
  return { models: [], failed: true }
}

/**
 * Reconcile Thinking Levels against the current catalog so the dialog cannot
 * submit an illegal model/effort pair. An unloaded catalog is not evidence of
 * absence — keep the current draft until membership is known.
 */
export const reconcileExecutionProfileDraft = (input: {
  readonly draft: ExecutionProfileDraft
  readonly models: readonly AgentModelOption[] | undefined
}): ExecutionProfileDraft => {
  if (input.models === undefined) {
    return input.draft
  }
  const buildThinkingLevel = reconcileVariantForModel(
    input.draft.buildThinkingLevel,
    thinkingLevelsForModel(input.models, input.draft.buildModel),
  )
  if (input.draft.reviewSameAsBuild) {
    return {
      buildModel: input.draft.buildModel,
      buildThinkingLevel,
      reviewSameAsBuild: true,
    }
  }
  return {
    buildModel: input.draft.buildModel,
    buildThinkingLevel,
    reviewSameAsBuild: false,
    reviewModel: input.draft.reviewModel,
    reviewThinkingLevel: reconcileVariantForModel(
      input.draft.reviewThinkingLevel,
      thinkingLevelsForModel(input.models, input.draft.reviewModel),
    ),
  }
}

/**
 * Operator-facing catalog block copy for Implement With. Does not mention
 * Recheck, Settings, or Save — this dialog has no recovery detour.
 */
export const implementWithCatalogBlockReason = (
  input: AgentModelCatalogState & {
    readonly modelId: string
    readonly requireSelection: boolean
    readonly backendId: string
    readonly configurationMode?: string | null
    readonly discoveryWarnings?: readonly string[]
  },
): string | null => {
  if (
    !blocksAgentModelSave({
      catalogLoading: input.catalogLoading,
      catalogFailed: input.catalogFailed,
      catalogModels: input.catalogModels,
      modelId: input.modelId,
      requireSelection: input.requireSelection,
    })
  ) {
    return null
  }
  const bedrock = isClaudeBedrockConfigurationMode(
    input.backendId,
    input.configurationMode,
  )
  if (input.catalogFailed === true) {
    return "Could not load the Agent Model catalog."
  }
  if (input.catalogLoading || input.catalogModels === undefined) {
    return "Loading the Agent Model catalog…"
  }
  if (input.catalogModels.length === 0) {
    const warning = input.discoveryWarnings?.find(
      (entry) => entry.trim().length > 0,
    )
    if (warning !== undefined) {
      return warning
    }
    return bedrock
      ? "No active Anthropic-backed Bedrock inference profiles were found for the resolved AWS region."
      : "Implement With requires a non-empty Agent Model catalog."
  }
  if (input.modelId.length === 0) {
    return bedrock
      ? "Select a discovered Bedrock inference profile."
      : "Select a model from the Agent Model catalog."
  }
  return bedrock
    ? "The selected model is not in the current Bedrock profile catalog. Choose a discovered profile."
    : "The selected model is not in the current Agent Model catalog. Choose a listed model."
}
