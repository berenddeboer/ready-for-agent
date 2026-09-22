export const FP_CLI_COMMAND = "fp"
export const FP_READY_LABEL = "ready-for-agent"
/**
 * fp statuses that mean the Issue is closed for the harness. A status the
 * project does not register is harmless; only registered statuses occur.
 */
export const FP_DEFAULT_CLOSED_STATUSES: readonly string[] = [
  "done",
  "rejected",
]

export type FpIssueState = "OPEN" | "CLOSED"

/** The one place that turns an fp status into OPEN or CLOSED. */
export const fpIssueState = (
  status: string,
  options: Pick<FpProjectOptions, "closedStatuses">,
): FpIssueState =>
  (options.closedStatuses ?? FP_DEFAULT_CLOSED_STATUSES).includes(status)
    ? "CLOSED"
    : "OPEN"

/** Remote identity of a linked fp project, from `fp project remote`. */
export interface FpProjectRemote {
  readonly workspaceSlug: string
  readonly projectId: string
}

/**
 * Deep link the fp desktop app registers; fp has no web URL for an Issue.
 * The form is Fiberplane's (`fp-deeplink` utility, 2026-09-22): workspace,
 * remote project id and the 32-character issue id. A project that is not
 * linked to a remote has no workspace or project id; the id-only form is a
 * stable identifier for it, not a link the app is known to resolve.
 */
export const fpIssueUrl = (
  remote: FpProjectRemote | null,
  nativeId: string,
): string =>
  remote === null
    ? `fp://issue?id=${encodeURIComponent(nativeId)}`
    : `fp://issue?workspace=${encodeURIComponent(remote.workspaceSlug)}&project=${encodeURIComponent(remote.projectId)}&id=${encodeURIComponent(nativeId)}`

/**
 * Configuration of one fp project as an Issue Tracker for one Repository.
 * `projectDirectory` is the registered fp project path (or any directory
 * inside it, or a git worktree of it); fp resolves the project from the
 * working directory and has no project flag.
 */
export interface FpProjectOptions {
  readonly projectDirectory: string
  /** Label that grants eligibility; defaults to `ready-for-agent`. */
  readonly readyLabel?: string
  /** Statuses reported as CLOSED; defaults to `done` and `rejected`. */
  readonly closedStatuses?: readonly string[]
  /**
   * When set, only Issues in these statuses are inspected for the Ready
   * label. Narrows the per-Issue `show` cost on large projects; the label
   * is still required. Unset means every open Issue is a candidate.
   */
  readonly candidateStatuses?: readonly string[]
}

export interface FpIssueReference {
  readonly nativeId: string
  readonly displayId: string
  readonly url: string
}

export interface FpIssueParent extends FpIssueReference {
  readonly state: FpIssueState
  readonly isReadyLabeled: boolean
}

/**
 * Tracker-native Ready-labeled Issue record. Field names mirror the Forge
 * `ReadyLabeledIssue` so the seam mapping is a spread, except that fp has no
 * integer issue number: that field is the seam's decision, not the adapter's.
 */
export interface FpIssue {
  /** fp's 32-character issue id. */
  readonly nativeId: string
  /** fp's display id, e.g. `MC-miygcidm`. */
  readonly displayId: string
  readonly title: string
  readonly body: string
  readonly url: string
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly status: string
  readonly state: FpIssueState
  /** fp author, an email address; null when fp reports none. */
  readonly author: string | null
  readonly labels: readonly string[]
  readonly parent: FpIssueParent | null
  /** 1-based creation order among siblings; null for a root Issue. */
  readonly parentPosition: number | null
  readonly hasChildren: boolean
  readonly hierarchySupported: true
  /** fp dependencies, as native blockers. */
  readonly blockedBy: readonly FpIssueReference[]
}

/** Live identity and status of one fp Issue, for claim and close-out. */
export interface FpIssueSnapshot {
  readonly nativeId: string
  readonly displayId: string
  readonly url: string
  readonly status: string
  readonly state: FpIssueState
  readonly labels: readonly string[]
}

export type FpReadiness =
  | { readonly _tag: "ready"; readonly version: string }
  | { readonly _tag: "cli_missing"; readonly message: string }
  | { readonly _tag: "project_not_registered"; readonly message: string }
