import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { AgentModelSelect } from "./agent-model-select.js"
import {
  type AgentModelOption,
  blocksAgentModelSave,
  formatUnavailableVariantLabel,
  formatVariantLabel,
  isClaudeBedrockConfigurationMode,
  isUnavailableCatalogModel,
  reconcileVariantForModel,
  thinkingLevelsForModel,
} from "./agent-model-settings.js"
import { Banner } from "./banner.js"
import {
  type ExecutionProfileDraft,
  type ImplementWithProfileInput,
  executionProfileInputFromDraft,
  implementWithCatalogBlockReason,
  reconcileExecutionProfileDraft,
} from "./execution-profile-draft.js"
import { cx, ui } from "./ui.js"

type ImplementWithCatalog = {
  readonly loading: boolean
  readonly failed: boolean
  readonly error: string | null
  readonly models: readonly AgentModelOption[] | undefined
  readonly warnings: readonly string[]
}

export type ImplementWithBackendOption = {
  readonly id: string
  readonly label: string
}

export type ImplementWithDialogProps = {
  readonly issueNumber: number
  readonly backendId: string
  readonly backends: readonly ImplementWithBackendOption[]
  readonly configurationMode: string | null
  readonly initialDraft: ExecutionProfileDraft
  readonly catalog: ImplementWithCatalog
  readonly prefsError?: string | null
  readonly submitPending: boolean
  readonly submitError: string | null
  readonly onSubmit: (profile: ImplementWithProfileInput) => void
  readonly onBackendChange: (backendId: string) => void
  readonly onCancel: () => void
}

type DraftSlot = {
  readonly source: "prefs" | "user"
  readonly draft: ExecutionProfileDraft
}

/**
 * Local modal that always pairs showModal with close on unmount so tearing
 * the node out of the tree cannot leave the document inert.
 */
export function ImplementWithModalDialog({
  labelledBy,
  preventCancel = false,
  onCancel,
  children,
}: {
  readonly labelledBy: string
  readonly preventCancel?: boolean
  readonly onCancel: () => void
  readonly children: ReactNode
}): ReactNode {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return
    if (!dialog.open) {
      dialog.showModal()
    }
    return () => {
      if (dialog.open) {
        dialog.close()
      }
    }
  }, [])
  return (
    <dialog
      ref={dialogRef}
      className={ui.dialogPanel}
      aria-labelledby={labelledBy}
      onCancel={(event) => {
        if (preventCancel) {
          event.preventDefault()
          return
        }
        onCancel()
      }}
    >
      {children}
    </dialog>
  )
}

const sameAsBuildDraft = (
  draft: ExecutionProfileDraft,
): Extract<ExecutionProfileDraft, { reviewSameAsBuild: true }> => ({
  buildModel: draft.buildModel,
  buildThinkingLevel: draft.buildThinkingLevel,
  reviewSameAsBuild: true,
})

/**
 * Ephemeral Implement issue #N with... dialog. Local modal state only — no
 * route, no history entry, drafts die when this unmounts.
 */
export function ImplementWithDialog({
  issueNumber,
  backendId,
  backends,
  configurationMode,
  initialDraft,
  catalog,
  prefsError = null,
  submitPending,
  submitError,
  onSubmit,
  onBackendChange,
  onCancel,
}: ImplementWithDialogProps): ReactNode {
  const draftSlotsRef = useRef<Record<string, DraftSlot>>({})
  const [draft, setDraft] = useState(() =>
    reconcileExecutionProfileDraft({
      draft: initialDraft,
      models: catalog.models,
    }),
  )
  const titleId = `implement-with-title-${issueNumber}`
  const backendLabel =
    backends.find((backend) => backend.id === backendId)?.label ?? backendId

  useLayoutEffect(() => {
    const slot = draftSlotsRef.current[backendId]
    const source = slot?.source === "user" ? "user" : "prefs"
    const nextDraft = reconcileExecutionProfileDraft({
      draft:
        source === "user" && slot !== undefined ? slot.draft : initialDraft,
      models: catalog.models,
    })
    draftSlotsRef.current[backendId] = { source, draft: nextDraft }
    setDraft(nextDraft)
  }, [backendId, catalog.models, initialDraft])

  const replaceDraft = (
    updater: (current: ExecutionProfileDraft) => ExecutionProfileDraft,
  ) => {
    setDraft((current) => {
      const next = updater(current)
      draftSlotsRef.current[backendId] = { source: "user", draft: next }
      return next
    })
  }

  const catalogModels = catalog.models
  const catalogState = {
    catalogLoading: catalog.loading,
    catalogFailed: catalog.failed,
    catalogModels,
  }
  const modelIds = (catalogModels ?? []).map((model) => model.id)
  const catalogLoaded = catalogModels !== undefined
  const claudeBedrockStrict = isClaudeBedrockConfigurationMode(
    backendId,
    configurationMode,
  )
  const buildVariants = thinkingLevelsForModel(catalogModels, draft.buildModel)
  const reviewModel = draft.reviewSameAsBuild ? "" : draft.reviewModel
  const reviewThinkingLevel = draft.reviewSameAsBuild
    ? ""
    : draft.reviewThinkingLevel
  const reviewThinkingLevels = thinkingLevelsForModel(
    catalogModels,
    reviewModel,
  )
  const buildUnavailable =
    catalogLoaded &&
    isUnavailableCatalogModel({
      modelId: draft.buildModel,
      catalogModelIds: modelIds,
    })
  const reviewUnavailable =
    !draft.reviewSameAsBuild &&
    catalogLoaded &&
    isUnavailableCatalogModel({
      modelId: draft.reviewModel,
      catalogModelIds: modelIds,
    })
  const buildBlockReason = implementWithCatalogBlockReason({
    ...catalogState,
    modelId: draft.buildModel,
    requireSelection: true,
    backendId,
    configurationMode,
    discoveryWarnings: catalog.warnings,
  })
  const reviewBlockReason = draft.reviewSameAsBuild
    ? null
    : implementWithCatalogBlockReason({
        ...catalogState,
        modelId: draft.reviewModel,
        requireSelection: true,
        backendId,
        configurationMode,
        discoveryWarnings: catalog.warnings,
      })
  const buildBlocked = blocksAgentModelSave({
    ...catalogState,
    modelId: draft.buildModel,
    requireSelection: true,
  })
  const reviewBlocked =
    !draft.reviewSameAsBuild &&
    blocksAgentModelSave({
      ...catalogState,
      modelId: draft.reviewModel,
      requireSelection: true,
    })
  const implementDisabled = submitPending || buildBlocked || reviewBlocked
  const hasCustomBuildVariant =
    draft.buildThinkingLevel.length > 0 &&
    !buildVariants.includes(draft.buildThinkingLevel)
  const hasCustomReviewVariant =
    reviewThinkingLevel.length > 0 &&
    !reviewThinkingLevels.includes(reviewThinkingLevel)
  const modelSelectDisabled =
    submitPending ||
    catalog.loading ||
    catalog.failed ||
    catalogModels === undefined

  const updateBuild = (nextModel: string) => {
    const nextVariants = thinkingLevelsForModel(catalogModels, nextModel)
    replaceDraft((current) => ({
      ...current,
      buildModel: nextModel,
      buildThinkingLevel: reconcileVariantForModel(
        current.buildThinkingLevel,
        nextVariants,
      ),
    }))
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (implementDisabled) return
    onSubmit(
      executionProfileInputFromDraft({
        agentBackendId: backendId,
        draft,
      }),
    )
  }

  return (
    <ImplementWithModalDialog
      labelledBy={titleId}
      preventCancel={submitPending}
      onCancel={onCancel}
    >
      <form onSubmit={handleSubmit}>
        <div className={ui.dialogHeader}>
          <p className={ui.dialogKicker}>Implement With</p>
          <h2 id={titleId} className={ui.dialogTitle}>
            Implement issue #{issueNumber} with...
          </h2>
          <p className={ui.dialogLede}>
            These choices apply only to this Work Item. They never change
            Repository settings or Harness Config.
          </p>
        </div>
        <div className={ui.dialogBodySectioned}>
          <section
            className={ui.dialogSection}
            aria-labelledby="implement-with-backend"
          >
            <div className={ui.dialogSectionHead}>
              <h3 id="implement-with-backend" className={ui.dialogSectionTitle}>
                Agent Backend
              </h3>
              <span className={ui.dialogSectionMeta}>Shipped</span>
            </div>
            <label className={ui.dialogField}>
              Agent Backend
              <select
                className={ui.dialogInput}
                name="agentBackend"
                value={backendId}
                disabled={submitPending}
                onChange={(event) => onBackendChange(event.target.value)}
              >
                {backends.some((backend) => backend.id === backendId) ? null : (
                  <option value={backendId}>{backendLabel}</option>
                )}
                {backends.map((backend) => (
                  <option key={backend.id} value={backend.id}>
                    {backend.label}
                  </option>
                ))}
              </select>
              <span className={ui.dialogFieldHint}>
                Previewing another Agent Backend does not change saved defaults.
                This Work Item will keep the backend you submit.
              </span>
            </label>
          </section>

          <section
            className={ui.dialogSection}
            aria-labelledby="implement-with-models"
          >
            <div className={ui.dialogSectionHead}>
              <h3 id="implement-with-models" className={ui.dialogSectionTitle}>
                Models
              </h3>
              <span className={ui.dialogSectionMeta}>Build · Review</span>
            </div>

            {prefsError !== null && (
              <Banner
                className={ui.bannerCompact}
                tone="alarm"
                tag="Error"
                role="alert"
              >
                {prefsError}
              </Banner>
            )}
            {catalog.failed && catalog.error !== null && (
              <Banner
                className={ui.bannerCompact}
                tone="alarm"
                tag="Error"
                role="alert"
              >
                {catalog.error}
              </Banner>
            )}

            <AgentModelSelect
              className={cx(ui.dialogField, ui.dialogFieldMono)}
              label="Build model"
              name="buildModel"
              value={draft.buildModel}
              models={catalogModels}
              catalogLoading={catalog.loading}
              allowClear={false}
              required
              disabled={modelSelectDisabled}
              placeholder={
                claudeBedrockStrict
                  ? "Select a Bedrock inference profile"
                  : "Select a build model"
              }
              emptyCatalogLabel={
                claudeBedrockStrict
                  ? "No Bedrock profiles available"
                  : "No Agent Models available"
              }
              blockReason={buildBlockReason}
              hint="Used for implement and other build steps."
              onChange={updateBuild}
            />

            {draft.buildModel.length > 0 && buildUnavailable ? (
              <Banner
                className={ui.bannerCompact}
                tone="alarm"
                tag="Model"
                role="alert"
              >
                Build effort (thinking) is unavailable — the selected model is
                not in the Agent Model catalog. Choose another build model.
              </Banner>
            ) : draft.buildModel.length > 0 &&
              catalogLoaded &&
              buildVariants.length === 0 ? (
              <p className={ui.dialogNote}>
                Build effort (thinking) is unavailable — this model has no
                effort (thinking) options.
              </p>
            ) : (
              <label className={ui.dialogField}>
                Build effort (thinking)
                <select
                  className={ui.dialogInput}
                  name="buildThinkingLevel"
                  value={draft.buildThinkingLevel}
                  disabled={
                    modelSelectDisabled || draft.buildModel.length === 0
                  }
                  onChange={(event) =>
                    replaceDraft((current) => ({
                      ...current,
                      buildThinkingLevel: event.target.value,
                    }))
                  }
                >
                  <option value="">
                    {buildVariants.length === 0
                      ? "Model default (no effort (thinking) options)"
                      : "Model default"}
                  </option>
                  {hasCustomBuildVariant && (
                    <option value={draft.buildThinkingLevel}>
                      {formatUnavailableVariantLabel(draft.buildThinkingLevel)}
                    </option>
                  )}
                  {buildVariants.map((variant) => (
                    <option key={variant} value={variant}>
                      {formatVariantLabel(variant)}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <AgentModelSelect
              className={cx(ui.dialogField, ui.dialogFieldMono)}
              label="Review model"
              name="reviewModel"
              value={reviewModel}
              models={catalogModels}
              catalogLoading={catalog.loading}
              allowClear
              required={false}
              disabled={modelSelectDisabled}
              placeholder="Same as build"
              emptyCatalogLabel="Same as build"
              blockReason={reviewBlockReason}
              hint="Same as build uses exactly the build Agent Model and Thinking Level."
              onChange={(nextModel) => {
                if (nextModel.length === 0) {
                  replaceDraft((current) => sameAsBuildDraft(current))
                  return
                }
                const nextVariants = thinkingLevelsForModel(
                  catalogModels,
                  nextModel,
                )
                replaceDraft((current) => ({
                  buildModel: current.buildModel,
                  buildThinkingLevel: current.buildThinkingLevel,
                  reviewSameAsBuild: false,
                  reviewModel: nextModel,
                  reviewThinkingLevel: reconcileVariantForModel(
                    current.reviewSameAsBuild
                      ? current.buildThinkingLevel
                      : current.reviewThinkingLevel,
                    nextVariants,
                  ),
                }))
              }}
            />

            {reviewModel.length > 0 && reviewUnavailable ? (
              <Banner
                className={ui.bannerCompact}
                tone="alarm"
                tag="Model"
                role="alert"
              >
                Review effort (thinking) is unavailable — the selected model is
                not in the Agent Model catalog. Choose another model or use Same
                as build.
              </Banner>
            ) : reviewModel.length > 0 &&
              catalogLoaded &&
              reviewThinkingLevels.length === 0 ? (
              <p className={ui.dialogNote}>
                Review effort (thinking) is unavailable — this model has no
                effort (thinking) options.
              </p>
            ) : (
              <label className={ui.dialogField}>
                Review effort (thinking)
                <select
                  className={ui.dialogInput}
                  name="reviewThinkingLevel"
                  value={reviewThinkingLevel}
                  disabled={
                    modelSelectDisabled ||
                    draft.reviewSameAsBuild ||
                    reviewModel.length === 0 ||
                    reviewThinkingLevels.length === 0
                  }
                  onChange={(event) =>
                    replaceDraft((current) =>
                      current.reviewSameAsBuild
                        ? current
                        : {
                            ...current,
                            reviewThinkingLevel: event.target.value,
                          },
                    )
                  }
                >
                  <option value="">
                    {draft.reviewSameAsBuild
                      ? "Same as build"
                      : "Model default"}
                  </option>
                  {hasCustomReviewVariant && (
                    <option value={reviewThinkingLevel}>
                      {formatUnavailableVariantLabel(reviewThinkingLevel)}
                    </option>
                  )}
                  {reviewThinkingLevels.map((variant) => (
                    <option key={`review-${variant}`} value={variant}>
                      {formatVariantLabel(variant)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </section>

          {submitError !== null && (
            <Banner
              className={ui.bannerCompact}
              tone="alarm"
              tag="Error"
              role="alert"
            >
              {submitError}
            </Banner>
          )}
        </div>
        <div className={ui.dialogFooter}>
          <button
            type="button"
            className={ui.plateMini}
            onClick={onCancel}
            disabled={submitPending}
          >
            Cancel
          </button>
          <button
            type="submit"
            className={ui.platePrimary}
            aria-busy={submitPending || undefined}
            disabled={implementDisabled}
          >
            {submitPending ? "Starting..." : "Implement"}
          </button>
        </div>
      </form>
    </ImplementWithModalDialog>
  )
}
