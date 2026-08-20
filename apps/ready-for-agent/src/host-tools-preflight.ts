type HostTool = {
  readonly name: string
  readonly installHint: string
}

const alwaysRequiredTools: ReadonlyArray<HostTool> = [
  {
    name: "git",
    installHint: "Install Git: https://git-scm.com/downloads",
  },
]

/** Forges gated by a PATH executable (the coding agent shells out to it). */
const FORGE_CLI_TOOLS = {
  github: {
    name: "gh",
    installHint: "Install GitHub CLI (gh): https://cli.github.com/",
  },
  gitlab: {
    name: "glab",
    installHint: "Install GitLab CLI (glab): https://docs.gitlab.com/cli/",
  },
} as const

/**
 * Azure DevOps has no `az`-CLI shellout convention in this codebase (PAT-only
 * auth), so its preflight requirement is an environment variable rather than
 * a PATH executable. Represented with the same `{ name, installHint }` shape
 * as a PATH tool so the missing-tool message stays uniform.
 */
const AZURE_DEVOPS_PAT_ENV_VAR = "AZURE_DEVOPS_EXT_PAT"
const AZURE_DEVOPS_ENV_REQUIREMENT: HostTool = {
  name: AZURE_DEVOPS_PAT_ENV_VAR,
  installHint:
    "Set the AZURE_DEVOPS_EXT_PAT environment variable to an Azure DevOps Personal Access Token: https://learn.microsoft.com/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate",
}

type RepositoryForge = "github" | "gitlab" | "azure-devops"

export type HostToolsPreflightOptions = {
  /**
   * Distinct Forges represented by persisted Repositories. `gh` is required
   * only for GitHub; `glab` only for GitLab; `AZURE_DEVOPS_EXT_PAT` only for
   * Azure DevOps. Omit for backwards-compatible GitHub-only behavior; pass an
   * empty list when no Repository exists.
   */
  readonly repositoryForges?: ReadonlyArray<string>
  /** Injectable for tests; defaults to reading `process.env`. */
  readonly hasEnvVar?: (name: string) => boolean
}

export type HostToolsPreflightResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly missing: ReadonlyArray<HostTool>
      readonly message: string
    }

const isRepositoryForge = (value: string): value is RepositoryForge =>
  value === "github" || value === "gitlab" || value === "azure-devops"

const resolveRepositoryForges = (
  options: HostToolsPreflightOptions,
): ReadonlyArray<RepositoryForge> => {
  const raw = options.repositoryForges ?? ["github"]
  const selected = new Set(raw.filter(isRepositoryForge))
  return (["github", "gitlab", "azure-devops"] as const).filter((forge) =>
    selected.has(forge),
  )
}

const cliToolForForge = (forge: RepositoryForge): HostTool | undefined => {
  switch (forge) {
    case "github":
      return FORGE_CLI_TOOLS.github
    case "gitlab":
      return FORGE_CLI_TOOLS.gitlab
    case "azure-devops":
      // Env-var gated (checked separately below), not a PATH tool.
      return undefined
    default: {
      const _exhaustive: never = forge
      return _exhaustive
    }
  }
}

const defaultHasEnvVar = (name: string): boolean => {
  const value = process.env[name]
  return typeof value === "string" && value.trim() !== ""
}

export const checkHostTools = (
  commandExists: (command: string) => boolean,
  options: HostToolsPreflightOptions = {},
): HostToolsPreflightResult => {
  const repositoryForges = resolveRepositoryForges(options)
  const hasEnvVar = options.hasEnvVar ?? defaultHasEnvVar

  const requiredCliTools: ReadonlyArray<HostTool> = [
    ...alwaysRequiredTools,
    ...repositoryForges
      .map((forge) => cliToolForForge(forge))
      .filter((tool): tool is HostTool => tool !== undefined),
  ]
  const missingCliTools = requiredCliTools.filter(
    (tool) => !commandExists(tool.name),
  )

  const missingEnvRequirements: ReadonlyArray<HostTool> =
    repositoryForges.includes("azure-devops") &&
    !hasEnvVar(AZURE_DEVOPS_PAT_ENV_VAR)
      ? [AZURE_DEVOPS_ENV_REQUIREMENT]
      : []

  const missing = [...missingCliTools, ...missingEnvRequirements]

  if (missing.length === 0) {
    return { ok: true }
  }

  const lines = [
    "Required host tools are missing:",
    ...missing.map((tool) => `  - ${tool.name}: ${tool.installHint}`),
    "",
    "Install the tools above, then run ready-for-agent again.",
    "Agent Backend executables are checked after start and never block the Harness UI.",
    "Keymaxxer is optional and does not block start.",
  ]

  return {
    ok: false,
    missing,
    message: lines.join("\n"),
  }
}
