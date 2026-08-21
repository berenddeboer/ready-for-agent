import type { ReadyLabeledIssue } from "@ready-for-agent/github-service"

export interface AzureDevOpsRepository {
  readonly forge: string
  readonly forgeHost: string
  /**
   * `<organization>/<project>` or, when the Git repository name differs from
   * the ADO project name, `<organization>/<project>/<repository>` — Azure
   * DevOps has no self-hosted Forge Host variance (unlike GitLab), so the
   * organization lives in Project Path rather than Forge Host. A project can
   * contain multiple, differently-named Git repositories; the optional
   * third segment carries the specific one this Repository points at (see
   * {@link splitAzureDevOpsProjectPath}). Omitting the third segment when
   * the repository name equals the project name keeps the common case's
   * Project Path spelling unchanged.
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
 * Project Path (`<organization>/<project>`, or `<organization>/<project>/<repository>`
 * when the Git repository name differs from the project) with provider
 * `azure-devops`. Forge Host is always the canonical `dev.azure.com`, so —
 * unlike GitLab, which must fold a variable self-hosted Forge Host into the
 * account — the Project Path alone is already a stable, unique account key.
 * A PAT is scoped per-organization in practice, so folding the repository
 * name in here too (rather than keying only on `<organization>/<project>`)
 * is harmless even though it means two differently-named repos in the same
 * project get distinct vault entries.
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
  /**
   * The Git repository name, when it differs from `project` (i.e. the
   * Project Path had a third segment). `undefined` means the Project Path
   * was the legacy two-segment form — callers needing the actual Git
   * repositoryId path segment should use {@link azureDevOpsRepositoryName}.
   */
  readonly repository: string | undefined
}

/**
 * Split a Project Path into its REST API path segments: either
 * `<organization>/<project>` (the common case, where the Git repository
 * shares the project's name) or `<organization>/<project>/<repository>`
 * (when a project contains a Git repository whose name differs from the
 * project's). Returns null for any Project Path that is not exactly two or
 * three non-empty segments (defensive — parseForgeRemote is the only
 * producer and always emits one of these two shapes).
 */
export const splitAzureDevOpsProjectPath = (
  projectPath: string,
): AzureDevOpsProjectIdentity | null => {
  const segments = projectPath.split("/")
  if (segments.length !== 2 && segments.length !== 3) return null
  const [organization, project, repository] = segments
  if (
    organization === undefined ||
    project === undefined ||
    organization.trim() === "" ||
    project.trim() === "" ||
    (repository !== undefined && repository.trim() === "")
  ) {
    return null
  }
  return { organization, project, repository }
}

/**
 * The Git repositoryId REST path segment for a Project Identity: the
 * explicit repository name if the Project Path carried one, else the
 * project name (the common-case assumption this issue's fix replaces with
 * an explicit lookup where the two differ).
 */
export const azureDevOpsRepositoryName = (
  identity: AzureDevOpsProjectIdentity,
): string => identity.repository ?? identity.project
