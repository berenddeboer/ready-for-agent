export type { LocalRepository } from "@ready-for-agent/local-git"

export type RepositorySummary = {
  readonly id: string
  readonly forge: string
  readonly forgeHost: string
  readonly projectPath: string
  readonly localPath: string
  readonly isBare: boolean
  readonly paused: boolean
}
