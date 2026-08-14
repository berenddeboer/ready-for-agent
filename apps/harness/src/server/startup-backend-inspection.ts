import { type Duration, Effect } from "effect"
import {
  AGENT_BACKEND_IDS,
  ActiveAgentBackend,
  type AgentBackendId,
  formatDefaultBackendUnavailableMessage,
  isSelectableAgentBackendId,
  listBuiltInAgentBackends,
} from "@ready-for-agent/agent-backend"
import { type DatabaseError, DbService } from "@ready-for-agent/db-service"

export type StartupBackendInspectionOptions = {
  readonly cwd: string
  readonly inspectTimeout: Duration.Input
  readonly previewTimeout: Duration.Input
}

/**
 * Automatic Harness startup inspection of every initial Active backend,
 * followed by default-backend operator guidance. Returns the guidance message
 * to log, or `null` when the default backend is Ready and no guidance applies.
 *
 * The confirmation policy for a transient malformed catalog lives here (via
 * `inspectStartupBackend`), not in explicit Preview or Recheck, so those remain
 * single-attempt.
 */
export const inspectBackendsAtStartup = (
  options: StartupBackendInspectionOptions,
): Effect.Effect<
  string | null,
  DatabaseError,
  ActiveAgentBackend | DbService
> =>
  Effect.gen(function* () {
    const active = yield* ActiveAgentBackend
    const db = yield* DbService

    // Startup inspect for every initial Active backend (selected-or-in-use).
    const statuses = yield* active.listStatuses
    for (const status of statuses) {
      yield* active.inspectStartupBackend(status.backend.id, {
        cwd: options.cwd,
        timeout: options.inspectTimeout,
      })
    }

    // When the harness default is Unavailable, probe other built-ins via
    // preview (no Active-set change) so first-run operators see Ready
    // alternatives early instead of a later model-catalog failure (#937).
    // Parallel + short timeout: guidance only; must not dominate cold start.
    const config = yield* db.getConfig
    const defaultBackendId = isSelectableAgentBackendId(
      config.selectedAgentBackend,
    )
      ? (config.selectedAgentBackend as AgentBackendId)
      : AGENT_BACKEND_IDS.opencode
    const defaultStatus = yield* active.getBackendStatus(defaultBackendId)
    if (defaultStatus === null || defaultStatus.kind !== "unavailable") {
      return null
    }

    const otherBackendIds = listBuiltInAgentBackends()
      .map((entry) => entry.descriptor.id)
      .filter((id) => id !== defaultBackendId)
    const previews = yield* Effect.all(
      otherBackendIds.map((id) =>
        active
          .preview(id, {
            cwd: options.cwd,
            timeout: options.previewTimeout,
          })
          .pipe(Effect.map((preview) => ({ id, preview }))),
      ),
      { concurrency: "unbounded" },
    )
    const readyBackendIds = previews
      .filter(({ preview }) => preview.kind === "ready")
      .map(({ id }) => id)
    const guidance = formatDefaultBackendUnavailableMessage({
      defaultBackendId,
      reason: defaultStatus.reason,
      readyBackendIds,
    })
    if (guidance !== null) {
      return guidance
    }
    if (
      defaultStatus.reason != null &&
      defaultStatus.reason.trim().length > 0
    ) {
      return `Default Agent Backend '${defaultBackendId}' is not available (${defaultStatus.reason}). Open Settings to choose another backend or install the CLI.`
    }
    return null
  })
