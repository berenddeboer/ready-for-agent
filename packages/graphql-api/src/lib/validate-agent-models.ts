import { Effect } from "effect"
import {
  ActiveAgentBackend,
  type AgentBackendId,
  getBuiltInAgentBackend,
  isSelectableAgentBackendId,
} from "@ready-for-agent/agent-backend"
import {
  type AgentModelSettingsSource,
  canonicalOptionalSetting,
  findCatalogEntry,
  thinkingLevelNotAdvertisedMessage,
  validateCatalogSelection,
} from "@ready-for-agent/work-item-lifecycle"

/**
 * Server-side Agent Model catalog enforcement (issues #838 / #1073).
 *
 * Settings is catalog-only, but a direct GraphQL request must not be able to
 * store an arbitrary model string or an unsupported Thinking Level that would
 * only fail later when the Agent Backend CLI is spawned. Both config and
 * repository mutations validate the next resolved selections against the
 * catalog of the backend the mutation is about to make effective.
 *
 * Model fields stay nullable strings in the schema (no static enum): the
 * catalog is discovered at runtime and differs per backend and provider mode.
 */

/** Model fields carried by Harness Config and Repository settings. */
export type AgentModelField = "defaultModel" | "reviewModel"

type ThinkingLevelField = "defaultThinkingLevel" | "reviewThinkingLevel"

export type SettingsCatalogField = AgentModelField | ThinkingLevelField

type ValidationCatalog =
  | {
      readonly _tag: "ready"
      readonly models: ReadonlyArray<{
        readonly id: string
        readonly thinkingLevels: ReadonlyArray<string>
      }>
    }
  | { readonly _tag: "unusable"; readonly reason: string | null }

const backendLabel = (backendId: string): string =>
  getBuiltInAgentBackend(backendId)?.descriptor.label ?? backendId

/**
 * Catalog for the backend a mutation is about to make selected/effective.
 *
 * An Active backend answers from its current status; anything else is resolved
 * through the same Preview path Settings uses, so a not-yet-Active draft
 * backend validates against what it would actually offer. A backend that is
 * Unavailable (or unknown) yields no catalog — membership cannot be
 * established, so explicit models are rejected rather than trusted.
 */
const resolveValidationCatalog = (
  backendId: string,
  inspectInput: { readonly cwd: string; readonly timeout: "30 seconds" },
): Effect.Effect<ValidationCatalog, never, ActiveAgentBackend> =>
  Effect.gen(function* () {
    if (!isSelectableAgentBackendId(backendId)) {
      return {
        _tag: "unusable",
        reason: `Unknown Agent Backend: ${backendId}`,
      } as const
    }
    const active = yield* ActiveAgentBackend
    const id = backendId as AgentBackendId
    const status = yield* active.getBackendStatus(id)
    if (status !== null) {
      return status.kind === "ready"
        ? ({ _tag: "ready", models: status.models } as const)
        : ({ _tag: "unusable", reason: status.reason } as const)
    }
    const preview = yield* active.preview(id, inspectInput)
    return preview.kind === "ready"
      ? ({ _tag: "ready", models: preview.models } as const)
      : ({ _tag: "unusable", reason: preview.reason } as const)
  })

const explicitModels = (
  models: Partial<Record<AgentModelField, string | null | undefined>>,
): ReadonlyArray<readonly [AgentModelField, string]> =>
  (["defaultModel", "reviewModel"] as const).flatMap((field) => {
    const value = canonicalOptionalSetting(models[field])
    return value === null ? [] : [[field, value] as const]
  })

type ApplicableThinkingLevel = {
  readonly field: ThinkingLevelField
  readonly role: "Build" | "Review"
  readonly model: string
  readonly thinkingLevel: string
}

/**
 * Thinking Levels that contribute to the next resolved build/review selection.
 * Dormant Repository levels (Harness still governs that role) are omitted so
 * they can be preserved without blocking an unrelated save.
 */
const applicableThinkingLevels = (input: {
  readonly scope: "harness" | "repository"
  readonly submitted: AgentModelSettingsSource
  readonly harness: AgentModelSettingsSource
}): readonly ApplicableThinkingLevel[] => {
  const submittedBuild = canonicalOptionalSetting(input.submitted.defaultModel)
  const submittedReview = canonicalOptionalSetting(input.submitted.reviewModel)
  const submittedBuildLevel = canonicalOptionalSetting(
    input.submitted.defaultThinkingLevel,
  )
  const submittedReviewLevel = canonicalOptionalSetting(
    input.submitted.reviewThinkingLevel,
  )
  const harnessBuild = canonicalOptionalSetting(input.harness.defaultModel)
  const harnessReview = canonicalOptionalSetting(input.harness.reviewModel)
  const applicable: ApplicableThinkingLevel[] = []

  if (input.scope === "harness") {
    if (submittedBuild !== null && submittedBuildLevel !== null) {
      applicable.push({
        field: "defaultThinkingLevel",
        role: "Build",
        model: submittedBuild,
        thinkingLevel: submittedBuildLevel,
      })
    }
    const reviewModel = submittedReview ?? submittedBuild
    if (reviewModel !== null && submittedReviewLevel !== null) {
      applicable.push({
        field: "reviewThinkingLevel",
        role: "Review",
        model: reviewModel,
        thinkingLevel: submittedReviewLevel,
      })
    }
    return applicable
  }

  if (submittedBuild !== null && submittedBuildLevel !== null) {
    applicable.push({
      field: "defaultThinkingLevel",
      role: "Build",
      model: submittedBuild,
      thinkingLevel: submittedBuildLevel,
    })
  }
  if (submittedReview !== null && submittedReviewLevel !== null) {
    applicable.push({
      field: "reviewThinkingLevel",
      role: "Review",
      model: submittedReview,
      thinkingLevel: submittedReviewLevel,
    })
  } else if (
    submittedReview === null &&
    harnessReview === null &&
    submittedReviewLevel !== null
  ) {
    const resolvedBuild = submittedBuild ?? harnessBuild
    if (resolvedBuild !== null) {
      applicable.push({
        field: "reviewThinkingLevel",
        role: "Review",
        model: resolvedBuild,
        thinkingLevel: submittedReviewLevel,
      })
    }
  }
  return applicable
}

const settingsCorrection =
  "Choose an advertised level or clear the field to use the applicable fallback or backend/model default."

/**
 * Reject explicit Agent Models and applicable Thinking Levels that the next
 * backend's current catalog does not offer. Empty and omitted values carry no
 * assertion about a model and are left alone — a null/omitted defaultModel is
 * a valid "inherit backend default" resting state on both Harness Config and
 * Repository settings (issue #33), and Repository inheritance keeps working.
 *
 * Dormant Repository Thinking Levels are not rejected. An unrelated Repository
 * save with no explicit catalog assertion and no applicable Thinking Level
 * does not inspect or Preview solely for validation.
 */
export const validateAgentModelsAgainstCatalog = <E>(input: {
  /** Next selected backend (config) / next Effective backend (repository). */
  readonly backendId: string
  readonly inspectInput: {
    readonly cwd: string
    readonly timeout: "30 seconds"
  }
  readonly models: Partial<Record<AgentModelField, string | null | undefined>>
  readonly thinking?: {
    readonly scope: "harness" | "repository"
    readonly submitted: AgentModelSettingsSource
    readonly harness: AgentModelSettingsSource
  }
  readonly onInvalid: (field: SettingsCatalogField, message: string) => E
}): Effect.Effect<void, E, ActiveAgentBackend> =>
  Effect.gen(function* () {
    const requested = explicitModels(input.models)
    const thinkingChecks =
      input.thinking === undefined
        ? []
        : applicableThinkingLevels(input.thinking)
    if (requested.length === 0 && thinkingChecks.length === 0) {
      return
    }
    const catalog = yield* resolveValidationCatalog(
      input.backendId,
      input.inspectInput,
    )
    const label = backendLabel(input.backendId)
    if (catalog._tag === "unusable") {
      const field = requested[0]?.[0] ?? thinkingChecks[0]?.field
      if (field === undefined) {
        return
      }
      const detail = catalog.reason === null ? "" : `: ${catalog.reason}`
      return yield* Effect.fail(
        input.onInvalid(
          field,
          `The ${label} Agent Model catalog is unavailable${detail}. Recheck Agent Backend, then choose a model it currently offers.`,
        ),
      )
    }
    for (const [field, value] of requested) {
      if (findCatalogEntry(catalog.models, value) === undefined) {
        return yield* Effect.fail(
          input.onInvalid(
            field,
            `Agent Model "${value}" is not in the current ${label} Agent Model catalog. Choose a model the Agent Backend currently offers.`,
          ),
        )
      }
    }
    for (const check of thinkingChecks) {
      const result = validateCatalogSelection({
        catalogEntry: findCatalogEntry(catalog.models, check.model),
        thinkingLevel: check.thinkingLevel,
      })
      if (result._tag === "model_absent") {
        return yield* Effect.fail(
          input.onInvalid(
            check.field,
            `Agent Model "${check.model}" is not in the current ${label} Agent Model catalog. Recheck Agent Backend, then choose a model it currently offers.`,
          ),
        )
      }
      if (result._tag === "thinking_level_absent") {
        return yield* Effect.fail(
          input.onInvalid(
            check.field,
            thinkingLevelNotAdvertisedMessage({
              role: check.role,
              thinkingLevel: result.thinkingLevel,
              model: result.model.id,
              backendLabel: label,
              advertised: result.model.thinkingLevels,
              guidance: settingsCorrection,
            }),
          ),
        )
      }
    }
  })
