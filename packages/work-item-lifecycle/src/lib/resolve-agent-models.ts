import { Effect } from "effect"
import {
  ActiveAgentBackend,
  type AgentBackendId,
  formatBuildModelNotConfiguredMessage,
  isSelectableAgentBackendId,
} from "@ready-for-agent/agent-backend"
import {
  type DatabaseError,
  DbService,
  type RepositoryRecord,
} from "@ready-for-agent/db-service"
import { BuildModelNotConfiguredError } from "./errors.js"

/** Resolved build and review Agent Model selection for one Agent Turn. */
export type AgentModelSelection = {
  readonly model: string
  readonly thinkingLevel: string | null
  readonly reviewModel: string
  readonly reviewThinkingLevel: string | null
}

/** Model fields shared by Repository settings and Harness Config. */
export type AgentModelSettingsSource = {
  readonly defaultModel: string | null
  readonly defaultThinkingLevel: string | null
  readonly reviewModel: string | null
  readonly reviewThinkingLevel: string | null
}

const nonEmpty = (value: string | null | undefined): value is string =>
  value !== null && value !== undefined && value.trim() !== ""

/**
 * Resolve build and review Agent Models from repository settings, falling back
 * to harness config. Review falls back to the resolved build selection when no
 * distinct review model is configured. Returns null when no build model can be
 * resolved.
 *
 * Callers that key prefs by Agent Backend must pass repository and harness
 * sources already projected for that backend (Repository flat columns project
 * the effective backend; harness fallback should use `getBackendModelPrefs`
 * for the captured backend, not the default backend's flat columns).
 */
export const resolveAgentModelSelection = (
  repository: AgentModelSettingsSource | null | undefined,
  config: AgentModelSettingsSource,
): AgentModelSelection | null => {
  const repoBuildModel = repository?.defaultModel
  const buildSelection = nonEmpty(repoBuildModel)
    ? {
        model: repoBuildModel,
        thinkingLevel: repository?.defaultThinkingLevel ?? null,
      }
    : {
        model: config.defaultModel,
        thinkingLevel: config.defaultThinkingLevel ?? null,
      }
  if (!nonEmpty(buildSelection.model)) {
    return null
  }
  const model = buildSelection.model
  const thinkingLevel = buildSelection.thinkingLevel
  const repoReviewModel = repository?.reviewModel
  const harnessReviewModel = config.reviewModel
  const reviewSelection = nonEmpty(repoReviewModel)
    ? {
        model: repoReviewModel,
        thinkingLevel: repository?.reviewThinkingLevel ?? null,
      }
    : nonEmpty(harnessReviewModel)
      ? {
          model: harnessReviewModel,
          thinkingLevel: config.reviewThinkingLevel ?? null,
        }
      : {
          model,
          thinkingLevel:
            repository?.reviewThinkingLevel ??
            config.reviewThinkingLevel ??
            thinkingLevel,
        }
  return {
    model,
    thinkingLevel,
    reviewModel: reviewSelection.model,
    reviewThinkingLevel: reviewSelection.thinkingLevel,
  }
}

/**
 * Load repository flat model columns and harness backend-scoped prefs for
 * `backendId`, then resolve Agent Models for the next Agent Turn. Fails when
 * no build model is configured for that backend.
 *
 * Error copy names the Agent Backend, repository/harness scope, Settings, and
 * Ready catalog model ids when ActiveAgentBackend is available (issue #937).
 */
export const resolveAgentModelsForBackend = (
  repositoryId: string,
  backendId: string,
): Effect.Effect<
  AgentModelSelection,
  BuildModelNotConfiguredError | DatabaseError,
  DbService | ActiveAgentBackend
> =>
  Effect.gen(function* () {
    const db = yield* DbService
    const repositories = yield* db.listRepositories
    const repository: RepositoryRecord | undefined = repositories.find(
      ({ id }) => id === repositoryId,
    )
    // Harness flat columns mirror the default backend; prefer the map entry
    // for the backend this Work Item (or create path) actually uses.
    const harnessPrefs = yield* db.getBackendModelPrefs(backendId)
    const selection = resolveAgentModelSelection(repository, harnessPrefs)
    if (selection === null) {
      let availableModelIds: readonly string[] | undefined
      if (isSelectableAgentBackendId(backendId)) {
        const active = yield* ActiveAgentBackend
        const status = yield* active.getBackendStatus(
          backendId as AgentBackendId,
        )
        if (status !== null && status.kind === "ready") {
          availableModelIds = status.models.map((model) => model.id)
        }
      }
      return yield* new BuildModelNotConfiguredError({
        message: formatBuildModelNotConfiguredMessage({
          backendId,
          repositoryProjectPath: repository?.projectPath,
          availableModelIds,
        }),
      })
    }
    return selection
  })

/**
 * Reject a resolved Agent Model that the Agent Backend's current Ready catalog
 * does not list (issue #838), before any Agent Backend CLI is spawned. Returns
 * actionable operator guidance, or null when the selection is usable.
 *
 * An empty catalog is not evidence of absence: a Ready backend that reported no
 * models (discovery gap, adapter without a catalog) carries no membership
 * information, and treating it as "every model is invalid" would stall every
 * Work Item on that backend. Settings already blocks *saving* into an empty
 * catalog, so admission defers to CLI-time failure in that case.
 */
export const agentModelCatalogViolation = (input: {
  readonly backendLabel: string
  readonly catalogModelIds: readonly string[]
  readonly selection: AgentModelSelection
  /** Review model is only used by the review step. */
  readonly includeReviewModel: boolean
}): string | null => {
  if (input.catalogModelIds.length === 0) {
    return null
  }
  const checked = [
    ["Build", input.selection.model] as const,
    ...(input.includeReviewModel
      ? [["Review", input.selection.reviewModel] as const]
      : []),
  ]
  for (const [role, model] of checked) {
    if (model.length > 0 && !input.catalogModelIds.includes(model)) {
      return `${role} Agent Model "${model}" is not in the current ${input.backendLabel} Agent Model catalog. Choose a model the Agent Backend currently offers in Settings, then start this work again.`
    }
  }
  return null
}

/**
 * Load current repository and harness settings and resolve Agent Models for
 * the next Agent Turn using the harness default backend's prefs map entry.
 * Prefer {@link resolveAgentModelsForBackend} when a captured or effective
 * backend id is known.
 */
export const resolveAgentModelsForRepository = (
  repositoryId: string,
): Effect.Effect<
  AgentModelSelection,
  BuildModelNotConfiguredError | DatabaseError,
  DbService | ActiveAgentBackend
> =>
  Effect.gen(function* () {
    const db = yield* DbService
    const config = yield* db.getConfig
    return yield* resolveAgentModelsForBackend(
      repositoryId,
      config.selectedAgentBackend,
    )
  })
