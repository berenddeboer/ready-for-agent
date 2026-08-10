import { agentBackendLabel } from "./registry.js"

/**
 * Cap available-model lists so operator errors stay scannable when a catalog
 * is large (OpenCode free-tier lists can be huge).
 */
const MAX_AVAILABLE_MODEL_IDS = 8

/**
 * Operator guidance when the harness default Agent Backend is Unavailable and
 * at least one other backend is Ready (issue #937 item 4).
 *
 * Example:
 * `Default Agent Backend 'opencode' is not available (not installed). Ready: claude.`
 */
export const formatDefaultBackendUnavailableMessage = (input: {
  readonly defaultBackendId: string
  readonly reason?: string | null
  readonly readyBackendIds: readonly string[]
}): string | null => {
  if (input.readyBackendIds.length === 0) {
    return null
  }
  const reason =
    input.reason != null && input.reason.trim().length > 0
      ? input.reason.trim()
      : "unavailable"
  const ready = input.readyBackendIds.join(", ")
  return `Default Agent Backend '${input.defaultBackendId}' is not available (${reason}). Ready: ${ready}.`
}

/**
 * Operator guidance when no build model is configured for the effective Agent
 * Backend (issue #937 item 5). Names the backend, scope, where to set a model,
 * and optionally a short catalog sample.
 *
 * Examples:
 * - `No build model set for acme/widgets on Agent Backend 'claude'. Available: haiku, sonnet. Set one in Settings, or per repository.`
 * - `No build model set for Agent Backend 'opencode' (harness default). Set one in Settings, or per repository.`
 */
export const formatBuildModelNotConfiguredMessage = (input: {
  readonly backendId: string
  /** Repository project path when known (e.g. owner/repo). */
  readonly repositoryProjectPath?: string | null
  /** Ready catalog model ids when known; omitted when empty or Unavailable. */
  readonly availableModelIds?: readonly string[]
}): string => {
  const backendLabel = agentBackendLabel(input.backendId)
  const projectPath = input.repositoryProjectPath?.trim()
  const scope =
    projectPath !== undefined && projectPath.length > 0
      ? `for ${projectPath} on Agent Backend '${backendLabel}'`
      : `for Agent Backend '${backendLabel}' (harness default)`

  const available = input.availableModelIds
    ?.map((id) => id.trim())
    .filter((id) => id.length > 0)
  const availableSnippet =
    available !== undefined && available.length > 0
      ? (() => {
          const shown = available.slice(0, MAX_AVAILABLE_MODEL_IDS)
          const more =
            available.length > MAX_AVAILABLE_MODEL_IDS
              ? `, … (+${available.length - MAX_AVAILABLE_MODEL_IDS} more)`
              : ""
          return ` Available: ${shown.join(", ")}${more}.`
        })()
      : ""

  return `No build model set ${scope}.${availableSnippet} Set one in Settings, or per repository.`
}
