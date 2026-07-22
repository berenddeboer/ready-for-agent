export interface GitHubRepository {
  readonly owner: string
  readonly name: string
}

export type TerminalPrStatusCheckOutcome = "green" | "red"

/**
 * One green or red PR Status Check execution observed on a pull request head.
 */
export interface TerminalPrStatusCheck {
  readonly externalId: string
  readonly name: string
  readonly outcome: TerminalPrStatusCheckOutcome
}

/**
 * Where a stored PR Status Check external id came from (prefix of the id).
 * Watch emits `actions-job:<id>` for Checks runs and Actions jobs, and
 * `status:<id>` for commit statuses.
 */
export type PrStatusCheckDiagnosticSource = "actions-job" | "status" | "unknown"

export type PrStatusCheckLogFetch =
  | {
      readonly _tag: "ok"
      readonly excerpt: string
      readonly localPath: string | null
    }
  | {
      readonly _tag: "unavailable"
      readonly reason: string
    }

/**
 * Harness-owned evidence for one red PR Status Check handed to Investigate.
 */
export interface PrStatusCheckDiagnostic {
  readonly externalId: string
  readonly name: string
  readonly source: PrStatusCheckDiagnosticSource
  readonly htmlUrl: string | null
  readonly logFetch: PrStatusCheckLogFetch
}

export interface PrStatusCheckDiagnosticsRequest {
  readonly externalId: string
  readonly name: string
}

export interface PrStatusCheckDiagnosticsOptions {
  /**
   * When set, successful log downloads are written under this directory and
   * `logFetch.localPath` points at the file.
   */
  readonly logDirectory?: string
  /** Max characters kept in `logFetch.excerpt` (tail of the log). */
  readonly maxExcerptChars?: number
}

export type PullRequestMergeability = "mergeable" | "conflicting" | "unknown"

export type PullRequestCheckStatus = (
  | {
      readonly _tag: "pending"
      readonly terminalChecks: readonly TerminalPrStatusCheck[]
    }
  | { readonly _tag: "no_checks" }
  | {
      readonly _tag: "succeeded"
      readonly terminalChecks: readonly TerminalPrStatusCheck[]
    }
  | {
      readonly _tag: "failed"
      readonly terminalChecks: readonly TerminalPrStatusCheck[]
    }
  | { readonly _tag: "closed" }
) & {
  readonly mergeability: PullRequestMergeability
  readonly baseRefName: string | null
  /**
   * When the current PR head commit was pushed, or null when GitHub omitted a
   * valid head-commit push time. Used only as a restart freshness signal.
   */
  readonly headPushedAt: Date | null
  /**
   * Current PR head commit OID, or null when GitHub omitted a valid head SHA.
   * Used to scope automated-review rerun budgets.
   */
  readonly headSha: string | null
}

export type GitHubIssueState = "OPEN" | "CLOSED"

export interface GitHubIssueReference {
  readonly number: number
  readonly url: string
}

export type GitHubPullRequestLifecycleState = "OPEN" | "MERGED" | "CLOSED"

/**
 * Lifecycle state of the pull request on a head ref, or not found.
 * Distinct from check rollup: used to detect human merge/close outcomes.
 */
export type PullRequestLifecycleStatus =
  | { readonly _tag: "open" }
  | { readonly _tag: "merged" }
  | { readonly _tag: "closed" }
  | { readonly _tag: "not_found" }

export type MergeRevalidationReason =
  | "head_changed"
  | "checks_not_green"
  | "mergeability_changed"

/** Domain result of a merge attempt; request/response failures remain errors. */
export type MergePullRequestResult =
  | { readonly _tag: "merged" }
  | {
      readonly _tag: "revalidation"
      readonly reason: MergeRevalidationReason
      readonly message: string
    }
  | {
      readonly _tag: "needs_human"
      readonly reason: "closed_unmerged" | "merge_rejected"
      readonly message: string
    }

export interface GitHubPullRequestReference {
  readonly number: number
  readonly repository: string
  readonly state: GitHubPullRequestLifecycleState
  readonly isDraft: boolean
}

export interface GitHubIssueParent extends GitHubIssueReference {
  readonly state: GitHubIssueState
  readonly isReadyLabeled: boolean
}

export interface ReadyLabeledIssue {
  readonly number: number
  readonly title: string
  readonly body: string
  readonly url: string
  readonly createdAt: Date
  readonly state: GitHubIssueState
  /** GitHub login of the Issue Author when provided; otherwise null. */
  readonly author: string | null
  readonly parent: GitHubIssueParent | null
  readonly parentPosition: number | null
  readonly hasChildren: boolean
  readonly hierarchySupported: boolean
  readonly blockedBy: readonly GitHubIssueReference[]
  readonly closingPullRequests: readonly GitHubPullRequestReference[]
}
