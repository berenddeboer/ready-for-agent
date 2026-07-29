export interface LocalRepository {
  readonly forge: "github" | "gitlab"
  readonly forgeHost: string
  readonly projectPath: string
  readonly localPath: string
  readonly isBare: boolean
  readonly paused: true
}

export type GitHubRemote = {
  readonly owner: string
  readonly repo: string
}

export type ForgeRemote = {
  readonly forge: "github" | "gitlab"
  readonly forgeHost: string
  readonly projectPath: string
}
