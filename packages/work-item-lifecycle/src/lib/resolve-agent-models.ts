import { Effect } from "effect"
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
 */
export const resolveAgentModelsForBackend = (
  repositoryId: string,
  backendId: string,
): Effect.Effect<
  AgentModelSelection,
  BuildModelNotConfiguredError | DatabaseError,
  DbService
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
      return yield* new BuildModelNotConfiguredError({
        message: "Select a default build model first",
      })
    }
    return selection
  })

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
  DbService
> =>
  Effect.gen(function* () {
    const db = yield* DbService
    const config = yield* db.getConfig
    return yield* resolveAgentModelsForBackend(
      repositoryId,
      config.selectedAgentBackend,
    )
  })
