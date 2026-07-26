export interface LocalRepository {
  readonly githubOwner: string
  readonly githubRepo: string
  readonly localPath: string
  readonly isBare: boolean
  readonly paused: true
}

export type GitHubRemote = {
  readonly owner: string
  readonly repo: string
}
