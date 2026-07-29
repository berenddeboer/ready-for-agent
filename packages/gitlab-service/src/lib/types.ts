import type { ReadyLabeledIssue } from "@ready-for-agent/github-service"

export interface GitLabRepository {
  readonly forge: string
  readonly forgeHost: string
  readonly projectPath: string
}

export type GitLabReadyLabeledIssue = ReadyLabeledIssue

/**
 * Keymaxxer vault account identity for a GitLab Repository:
 * `<forge-host>/<project-path>` with provider `gitlab`.
 */
export const gitlabVaultAccount = (repository: GitLabRepository): string =>
  `${repository.forgeHost}/${repository.projectPath}`

/**
 * Shared vault metadata budget (seconds) before ambient fallback.
 * Used by harness Keymaxxer GitLab layer and Agent Turn resolution so they
 * cannot drift independently.
 */
export const GITLAB_VAULT_METADATA_BUDGET_SECONDS = 20 as const
