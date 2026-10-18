import type { IssueRecord } from "@ready-for-agent/db-service"
import {
  type Forge,
  type IssueSource,
  describeIssueTracker,
  forgeForIssueSource,
  formatIssueDisplayId,
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

/**
 * Dispatch on how the Original Issue Source's Issue Tracker identifies an
 * Issue: by the Forge issue number or by its native identity. A context
 * without a source keeps the issue number.
 */
const byIssueIdentity = <A>(
  source: IssueSource | undefined,
  cases: {
    readonly issue_number: () => A
    readonly native_id: (source: IssueSource) => A
  },
): A => {
  if (source === undefined) {
    return cases.issue_number()
  }
  const identity = describeIssueTracker(source.tracker).issueIdentity
  switch (identity.kind) {
    case "issue_number":
      return cases.issue_number()
    case "native_id":
      return cases.native_id(source)
    default: {
      const _exhaustive: never = identity
      return _exhaustive
    }
  }
}

/** The stored Issue a Work Item was started from. */
export const findStoredIssueForSource = (
  issues: readonly IssueRecord[],
  source: IssueSource | undefined,
  issueNumber: number,
): IssueRecord | undefined =>
  byIssueIdentity(source, {
    issue_number: () =>
      issues.find((candidate) => candidate.issueNumber === issueNumber),
    native_id: ({ nativeId }) =>
      issues.find((candidate) => candidate.nativeId === nativeId),
  })

/** Human-readable label for the Work Item's Issue in messages. */
export const issueLabelForSource = (
  source: IssueSource | undefined,
  issueNumber: number,
): string =>
  byIssueIdentity(source, {
    issue_number: () => `#${issueNumber}`,
    native_id: ({ displayId }) => formatIssueDisplayId(displayId),
  })
