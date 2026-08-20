import type { ReadyLabeledIssue } from "@ready-for-agent/github-service"

export interface AzureDevOpsRepository {
  readonly forge: string
  readonly forgeHost: string
  /**
   * `<organization>/<project>` — Azure DevOps has no self-hosted Forge Host
   * variance (unlike GitLab), so the organization lives in Project Path
   * rather than Forge Host. One Repository maps to one ADO project; a
   * project with multiple Git repos is out of scope (matches the existing
   * one-remote-one-forge assumption in parseForgeRemote).
   */
  readonly projectPath: string
}

export type AzureDevOpsReadyLabeledIssue = ReadyLabeledIssue

/**
 * Canonical Azure DevOps Forge Host. Both `dev.azure.com` and legacy
 * `<org>.visualstudio.com` clone remotes resolve to this one Forge Host so a
 * Repository has a single stable identity regardless of clone URL spelling.
 */
export const AZURE_DEVOPS_FORGE_HOST = "dev.azure.com" as const

/** Environment variable carrying the Azure DevOps Personal Access Token. */
export const AZURE_DEVOPS_PAT_ENV_VAR = "AZURE_DEVOPS_EXT_PAT" as const

/**
 * Keymaxxer vault account identity for an Azure DevOps Repository:
 * `<organization>/<project>` (== Project Path) with provider `azure-devops`.
 * Forge Host is always the canonical `dev.azure.com`, so — unlike GitLab,
 * which must fold a variable self-hosted Forge Host into the account — the
 * Project Path alone is already a stable, unique account key.
 */
export const azureDevOpsVaultAccount = (
  repository: AzureDevOpsRepository,
): string => repository.projectPath

/**
 * Shared vault metadata budget (seconds) before ambient fallback.
 * Mirrors GitLab's permissive posture: a vault miss/timeout/error falls back
 * to the ambient `AZURE_DEVOPS_EXT_PAT` rather than failing closed.
 */
export const AZURE_DEVOPS_VAULT_METADATA_BUDGET_SECONDS = 20 as const

export type AzureDevOpsProjectIdentity = {
  readonly organization: string
  readonly project: string
}

/**
 * Split a Project Path (`<organization>/<project>`) into its two REST API
 * path segments. Returns null for any Project Path that is not exactly two
 * non-empty segments (defensive — parseForgeRemote is the only producer and
 * always emits this shape).
 */
export const splitAzureDevOpsProjectPath = (
  projectPath: string,
): AzureDevOpsProjectIdentity | null => {
  const segments = projectPath.split("/")
  if (segments.length !== 2) return null
  const [organization, project] = segments
  if (
    organization === undefined ||
    project === undefined ||
    organization.trim() === "" ||
    project.trim() === ""
  ) {
    return null
  }
  return { organization, project }
}
