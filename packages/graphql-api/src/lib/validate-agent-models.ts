import { Effect } from "effect"
import {
  ActiveAgentBackend,
  type AgentBackendId,
  getBuiltInAgentBackend,
  isSelectableAgentBackendId,
} from "@ready-for-agent/agent-backend"

/**
 * Server-side Agent Model catalog enforcement (issue #838).
 *
 * Settings is catalog-only, but a direct GraphQL request must not be able to
 * store an arbitrary model string that would only fail later when the Agent
 * Backend CLI is spawned. Both config and repository mutations validate every
 * explicit model against the catalog of the backend the mutation is about to
 * make effective.
 *
 * Model fields stay nullable strings in the schema (no static enum): the
 * catalog is discovered at runtime and differs per backend and provider mode.
 */

/** Model fields carried by Harness Config and Repository settings. */
export type AgentModelField = "defaultModel" | "reviewModel"

type ValidationCatalog =
  | { readonly _tag: "ready"; readonly modelIds: readonly string[] }
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
        ? ({
            _tag: "ready",
            modelIds: status.models.map((model) => model.id),
          } as const)
        : ({ _tag: "unusable", reason: status.reason } as const)
    }
    const preview = yield* active.preview(id, inspectInput)
    return preview.kind === "ready"
      ? ({
          _tag: "ready",
          modelIds: preview.models.map((model) => model.id),
        } as const)
      : ({ _tag: "unusable", reason: preview.reason } as const)
  })

const explicitModels = (
  models: Partial<Record<AgentModelField, string | null | undefined>>,
): ReadonlyArray<readonly [AgentModelField, string]> =>
  (["defaultModel", "reviewModel"] as const).flatMap((field) => {
    const value = models[field]?.trim() ?? ""
    return value.length === 0 ? [] : [[field, value] as const]
  })

/**
 * Reject explicit Agent Models that the next backend's current catalog does not
 * offer. Empty and omitted values carry no assertion about a model and are left
 * alone — Harness Config's own "build model required" rule and Repository
 * inheritance both keep working.
 */
export const validateAgentModelsAgainstCatalog = <E>(input: {
  /** Next selected backend (config) / next Effective backend (repository). */
  readonly backendId: string
  readonly inspectInput: {
    readonly cwd: string
    readonly timeout: "30 seconds"
  }
  readonly models: Partial<Record<AgentModelField, string | null | undefined>>
  readonly onInvalid: (field: AgentModelField, message: string) => E
}): Effect.Effect<void, E, ActiveAgentBackend> =>
  Effect.gen(function* () {
    const requested = explicitModels(input.models)
    if (requested.length === 0) {
      // Nothing explicit to validate — never inspect or Preview just to save
      // unrelated settings.
      return
    }
    const catalog = yield* resolveValidationCatalog(
      input.backendId,
      input.inspectInput,
    )
    const label = backendLabel(input.backendId)
    if (catalog._tag === "unusable") {
      const [field] = requested[0]
      const detail = catalog.reason === null ? "" : `: ${catalog.reason}`
      return yield* Effect.fail(
        input.onInvalid(
          field,
          `The ${label} Agent Model catalog is unavailable${detail}. Recheck Agent Backend, then choose a model it currently offers.`,
        ),
      )
    }
    for (const [field, value] of requested) {
      if (!catalog.modelIds.includes(value)) {
        return yield* Effect.fail(
          input.onInvalid(
            field,
            `Agent Model "${value}" is not in the current ${label} Agent Model catalog. Choose a model the Agent Backend currently offers.`,
          ),
        )
      }
    }
  })
