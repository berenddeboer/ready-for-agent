export interface LocalRepository {
  readonly forge: "github"
  readonly forgeHost: "github.com"
  readonly projectPath: string
  readonly localPath: string
  readonly isBare: boolean
  readonly paused: true
}

export type GitHubRemote = {
  readonly owner: string
  readonly repo: string
}
