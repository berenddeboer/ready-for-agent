import { Effect } from "effect"
import {
  ActiveAgentBackend,
  isSelectableAgentBackendId,
} from "@ready-for-agent/agent-backend"
import {
  type DatabaseError,
  DbService,
  RepositoryNotFoundError,
} from "@ready-for-agent/db-service"
import {
  AgentBackendUnavailableError,
  BuildModelNotConfiguredError,
  resolveAgentModelsForBackend,
  resolvedSelectionCatalogViolation,
} from "@ready-for-agent/work-item-lifecycle"

/**
 * Shared Repository-scoped preflight for Intake Candidate listing and
 * Repository Intake. Validates the effective Agent Backend is usable for Agent
 * Turns and that resolved build/review Agent Models pass catalog membership
 * when the backend reports a Ready catalog.
 *
 * Re-reads Repository and Harness Config inside Config coordination so the
 * effective backend and model resolution stay consistent (same admission seam
 * as Work Item creation).
 */
export const preflightRepositoryIntake = (
  repositoryId: string,
): Effect.Effect<
  void,
  | AgentBackendUnavailableError
  | BuildModelNotConfiguredError
  | DatabaseError
  | RepositoryNotFoundError,
  DbService | ActiveAgentBackend
> =>
  Effect.gen(function* () {
    const db = yield* DbService
    const activeAgentBackend = yield* ActiveAgentBackend

    yield* activeAgentBackend.withConfigCoordination(
      Effect.gen(function* () {
        // Re-read under coordination so selectedAgentBackend and flat model
        // columns cannot diverge from a pre-coordination snapshot while
        // resolveAgentModelsForBackend re-lists repositories.
        const harnessConfig = yield* db.getConfig
        const repositories = yield* db.listRepositories
        const repository = repositories.find(({ id }) => id === repositoryId)
        if (repository === undefined) {
          return yield* new RepositoryNotFoundError({ repositoryId })
        }

        const rawCaptureBackendId =
          repository.selectedAgentBackend ?? harnessConfig.selectedAgentBackend
        if (!isSelectableAgentBackendId(rawCaptureBackendId)) {
          return yield* new AgentBackendUnavailableError({
            message: `Unknown or unsupported Agent Backend: ${rawCaptureBackendId}`,
            reason: `Unknown or unsupported Agent Backend: ${rawCaptureBackendId}`,
          })
        }
        const captureBackendId = rawCaptureBackendId
        yield* activeAgentBackend
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

        const selection = yield* resolveAgentModelsForBackend(
          repositoryId,
          captureBackendId,
        )

        const captureStatus =
          yield* activeAgentBackend.getBackendStatus(captureBackendId)
        if (captureStatus !== null && captureStatus.kind === "ready") {
          const violation = resolvedSelectionCatalogViolation({
            backendLabel: captureStatus.backend.label,
            catalog: captureStatus.models,
            selection,
            includeReviewModel: true,
          })
          if (violation !== null) {
            return yield* new BuildModelNotConfiguredError({
              message: violation.message,
            })
          }
        }
      }),
    )
  })
