export type { LocalRepository } from "@ready-for-agent/local-git"

export type RepositorySummary = {
  readonly id: string
  readonly githubOwner: string
  readonly githubRepo: string
  readonly localPath: string
  readonly isBare: boolean
  readonly paused: boolean
}
