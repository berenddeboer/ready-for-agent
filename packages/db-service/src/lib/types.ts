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
}

export interface StoreIssueInput {
  readonly repositoryId: string
  readonly githubIssueNumber: number
  readonly title: string
  readonly githubCreatedAt: Date
}

export interface IssueRecord {
  readonly id: string
  readonly repositoryId: string
  readonly githubIssueNumber: number
  readonly title: string
  readonly githubCreatedAt: Date
}
