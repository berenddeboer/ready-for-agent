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

const FORGE_HOST_TOOLS = {
  github: {
    name: "gh",
    installHint: "Install GitHub CLI (gh): https://cli.github.com/",
  },
  gitlab: {
    name: "curl",
    installHint: "Install curl: https://curl.se/download.html",
  },
} as const

type RepositoryForge = keyof typeof FORGE_HOST_TOOLS

export type HostToolsPreflightOptions = {
  /**
   * Distinct Forges represented by persisted Repositories. `gh` is required
   * only for GitHub; `curl` only for GitLab. Omit for backwards-compatible
   * GitHub-only behavior; pass an empty list when no Repository exists.
   */
  readonly repositoryForges?: ReadonlyArray<string>
}

export type HostToolsPreflightResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly missing: ReadonlyArray<HostTool>
      readonly message: string
    }

const resolveRepositoryForges = (
  options: HostToolsPreflightOptions,
): ReadonlyArray<RepositoryForge> => {
  const raw = options.repositoryForges ?? ["github"]
  const selected = new Set(
    raw.filter(
      (forge): forge is RepositoryForge =>
        forge === "github" || forge === "gitlab",
    ),
  )
  return (["github", "gitlab"] as const).filter((forge) => selected.has(forge))
}

export const checkHostTools = (
  commandExists: (command: string) => boolean,
  options: HostToolsPreflightOptions = {},
): HostToolsPreflightResult => {
  const repositoryForges = resolveRepositoryForges(options)
  const requiredTools: ReadonlyArray<HostTool> = [
    ...alwaysRequiredTools,
    ...repositoryForges.map((forge) => FORGE_HOST_TOOLS[forge]),
  ]
  const missing = requiredTools.filter((tool) => !commandExists(tool.name))

  if (missing.length === 0) {
    return { ok: true }
  }

  const lines = [
    "Required host tools are missing from PATH:",
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
