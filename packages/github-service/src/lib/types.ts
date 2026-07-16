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

export type PullRequestCheckStatus =
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

export type GitHubIssueState = "OPEN" | "CLOSED"

export interface GitHubIssueReference {
  readonly number: number
  readonly url: string
}

export interface GitHubPullRequestReference {
  readonly number: number
  readonly repository: string
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
  readonly parent: GitHubIssueParent | null
  readonly parentPosition: number | null
  readonly hasChildren: boolean
  readonly hierarchySupported: boolean
  readonly blockedBy: readonly GitHubIssueReference[]
  readonly closingPullRequests: readonly GitHubPullRequestReference[]
}
