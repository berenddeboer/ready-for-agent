export interface GitHubRepository {
  readonly owner: string
  readonly name: string
}

export type PullRequestCheckStatus =
  | { readonly _tag: "pending" }
  | { readonly _tag: "no_checks" }
  | { readonly _tag: "succeeded" }
  | { readonly _tag: "failed" }
  | { readonly _tag: "closed" }

export type GitHubIssueState = "OPEN" | "CLOSED"

export interface GitHubIssueReference {
  readonly number: number
  readonly url: string
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
}
