export interface GitHubRepository {
  readonly owner: string
  readonly name: string
}

export type GitHubIssueState = "OPEN" | "CLOSED"

export interface ReadyLabeledIssue {
  readonly number: number
  readonly title: string
  readonly body: string
  readonly url: string
  readonly createdAt: Date
  readonly state: GitHubIssueState
}
