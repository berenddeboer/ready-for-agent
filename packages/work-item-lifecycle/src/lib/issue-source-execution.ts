import {
  type Forge,
  type IssueSource,
  forgeForIssueSource,
} from "@ready-for-agent/lifecycle-model"

/**
 * Forge used for Work Item issue operations. Prefers the captured Original
 * Issue Source; falls back to the Repository hosting Forge only when the
 * step context has no source (legacy callers). Linear sources are not a
 * Forge and return null rather than redirecting to hosting.
 */
export const issueOperationsForge = (
  source: IssueSource | undefined,
  repositoryForge: Forge,
): Forge | null =>
  source === undefined ? repositoryForge : forgeForIssueSource(source)
