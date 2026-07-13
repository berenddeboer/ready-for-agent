export interface AddRepositoryInput {
  readonly githubOwner: string
  readonly githubRepo: string
  readonly localPath: string
  readonly isBare: boolean
}

export interface RepositoryRecord {
  readonly id: string
  readonly githubOwner: string
  readonly githubRepo: string
  readonly localPath: string
  readonly isBare: boolean
  readonly paused: boolean
  readonly issuesReconciledAt: Date | null
}

export interface StoreIssueInput {
  readonly repositoryId: string
  readonly githubIssueNumber: number
  readonly title: string
  readonly body: string
  readonly url: string
  readonly state: IssueState
  readonly githubCreatedAt: Date
}

export type IssueState = "OPEN" | "CLOSED"

export interface IssueRecord {
  readonly id: string
  readonly repositoryId: string
  readonly githubIssueNumber: number
  readonly title: string
  readonly body: string
  readonly url: string
  readonly state: IssueState
  readonly githubCreatedAt: Date
}
