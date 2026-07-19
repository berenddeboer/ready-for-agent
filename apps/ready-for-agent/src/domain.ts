export interface LocalRepository {
  readonly githubOwner: string
  readonly githubRepo: string
  readonly localPath: string
  readonly isBare: boolean
  readonly paused: true
}

export type RepositorySummary = {
  readonly id: string
  readonly githubOwner: string
  readonly githubRepo: string
  readonly localPath: string
  readonly isBare: boolean
  readonly paused: boolean
}
