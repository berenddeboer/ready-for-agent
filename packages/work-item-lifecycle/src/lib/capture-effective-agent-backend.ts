import { Effect } from "effect"
import {
  type ActiveAgentBackendShape,
  type AgentBackendId,
  isSelectableAgentBackendId,
} from "@ready-for-agent/agent-backend"
import {
  type ConfigRecord,
  type DatabaseError,
  RepositoryNotFoundError,
  type RepositoryRecord,
} from "@ready-for-agent/db-service"
import {
  AgentBackendUnavailableError,
  BuildModelNotConfiguredError,
} from "./errors.js"
import {
  type AgentModelSelection,
  resolvedSelectionCatalogViolation,
} from "./resolve-agent-models.js"

/**
 * Capture the effective Agent Backend and reject a Ready catalog that does
 * not contain the resolved build and review models.
 *
 * Call inside Config coordination. A Repository override wins; otherwise the
 * harness default is captured. Models are resolved against that backend and
 * are not stored on the Work Item.
 *
 * Missing Repository is a not-found failure for CI Repair, which has no other
 * identity. Ordinary Issue start already resolved the Repository and falls
 * back to the harness default if the row disappears during coordination.
 */
export const captureEffectiveAgentBackend = (input: {
  readonly repositoryId: string
  readonly db: {
    readonly getConfig: Effect.Effect<ConfigRecord, DatabaseError>
    readonly listRepositories: Effect.Effect<
      readonly RepositoryRecord[],
      DatabaseError
    >
  }
  readonly activeAgentBackend: Pick<
    ActiveAgentBackendShape,
    "getBackendStatus" | "requireAgentTurnsAllowed" | "getRegistration"
  >
  readonly resolveModelsForBackend: (
    repositoryId: string,
    backendId: string,
  ) => Effect.Effect<
    AgentModelSelection,
    BuildModelNotConfiguredError | DatabaseError
  >
  readonly whenRepositoryMissing: "use-harness-default" | "not-found"
}): Effect.Effect<
  {
    readonly agentBackendId: AgentBackendId
    /** Null only when a missing Repository falls back to the harness default. */
    readonly repository: RepositoryRecord | null
  },
  | AgentBackendUnavailableError
  | BuildModelNotConfiguredError
  | DatabaseError
  | RepositoryNotFoundError
> =>
  Effect.gen(function* () {
    const harnessConfig = yield* input.db.getConfig
    const repositories = yield* input.db.listRepositories
    const repository = repositories.find(({ id }) => id === input.repositoryId)
    if (
      repository === undefined &&
      input.whenRepositoryMissing === "not-found"
    ) {
      return yield* new RepositoryNotFoundError({
        repositoryId: input.repositoryId,
      })
    }
    const rawCaptureBackendId =
      repository?.selectedAgentBackend ?? harnessConfig.selectedAgentBackend
    if (!isSelectableAgentBackendId(rawCaptureBackendId)) {
      return yield* new AgentBackendUnavailableError({
        message: `Unknown or unsupported Agent Backend: ${rawCaptureBackendId}`,
        reason: `Unknown or unsupported Agent Backend: ${rawCaptureBackendId}`,
      })
    }
    const captureBackendId = rawCaptureBackendId
    const capturedSelection = yield* input.resolveModelsForBackend(
      input.repositoryId,
      captureBackendId,
    )
    const captureStatus =
      yield* input.activeAgentBackend.getBackendStatus(captureBackendId)
    if (captureStatus !== null && captureStatus.kind === "ready") {
      const violation = resolvedSelectionCatalogViolation({
        backendLabel: captureStatus.backend.label,
        catalog: captureStatus.models,
        selection: capturedSelection,
        includeReviewModel: true,
      })
      if (violation !== null) {
        return yield* new BuildModelNotConfiguredError({
          message: violation.message,
        })
      }
    }
    yield* input.activeAgentBackend
      .requireAgentTurnsAllowed(captureBackendId)
      .pipe(
        Effect.mapError(
          (error) =>
            new AgentBackendUnavailableError({
              message: error.message,
              reason: error.reason,
            }),
        ),
      )
    const activeRegistration =
      yield* input.activeAgentBackend.getRegistration(captureBackendId)
    return {
      agentBackendId: activeRegistration.descriptor.id,
      repository: repository ?? null,
    }
  })
