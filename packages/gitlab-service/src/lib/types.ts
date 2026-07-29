import type { ReadyLabeledIssue } from "@ready-for-agent/github-service"

export interface GitLabRepository {
  readonly forge: string
  readonly forgeHost: string
  readonly projectPath: string
}

export type GitLabReadyLabeledIssue = ReadyLabeledIssue
