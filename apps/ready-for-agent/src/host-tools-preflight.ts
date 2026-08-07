import {
  AGENT_BACKEND_IDS,
  type AgentBackendId,
  defaultAgentBackendId,
  getBuiltInAgentBackend,
  isSelectableAgentBackendId,
} from "@ready-for-agent/agent-backend"

type HostTool = {
  readonly name: string
  readonly installHint: string
  readonly required: boolean
}

const BACKEND_HOST_TOOLS: Record<
  AgentBackendId,
  { readonly name: string; readonly installHint: string }
> = {
  [AGENT_BACKEND_IDS.opencode]: {
    name: "opencode",
    installHint: "Install OpenCode: https://opencode.ai",
  },
  [AGENT_BACKEND_IDS.grok]: {
    name: "grok",
    installHint:
      "Install Grok Build CLI: https://docs.x.ai/docs/grok-build (binary name: grok)",
  },
  [AGENT_BACKEND_IDS.codex]: {
    name: "codex",
    installHint:
      "Install Codex CLI: https://developers.openai.com/codex/cli (binary name: codex)",
  },
  [AGENT_BACKEND_IDS.claude]: {
    name: "claude",
    installHint:
      "Install Claude Code CLI: https://docs.anthropic.com/en/docs/claude-code (binary name: claude)",
  },
}

const alwaysRequiredTools: ReadonlyArray<HostTool> = [
  {
    name: "git",
    installHint: "Install Git: https://git-scm.com/downloads",
    required: true,
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

const optionalTools: ReadonlyArray<HostTool> = [
  {
    name: "keymaxxer",
    installHint:
      "Keymaxxer is optional. Install when you want vault-backed secrets; ambient Forge auth remains available without it.",
    required: false,
  },
]

export type HostToolsPreflightOptions = {
  /**
   * Selected Agent Backend ids that cold-start preflight must cover
   * (harness default ∪ Repository overrides). Unknown ids are ignored.
   * Combined with {@link selectedAgentBackendId} when both are set; if neither
   * yields a selectable id, OpenCode is required unless an explicit empty list
   * says no backend has been selected yet.
   */
  readonly selectedAgentBackendIds?: ReadonlyArray<string>
  /**
   * Single selected backend id (legacy convenience). Prefer
   * {@link selectedAgentBackendIds} when multiple backends may be selected.
   * Merged into the required set when present (including when the plural list
   * is empty).
   */
  readonly selectedAgentBackendId?: string
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

const resolveRequiredAgentBackendIds = (
  options: HostToolsPreflightOptions,
): ReadonlyArray<AgentBackendId> => {
  const raw = [
    ...(options.selectedAgentBackendIds ?? []),
    ...(options.selectedAgentBackendId !== undefined
      ? [options.selectedAgentBackendId]
      : []),
  ]

  const seen = new Set<AgentBackendId>()
  const resolved: AgentBackendId[] = []
  for (const value of raw) {
    if (!isSelectableAgentBackendId(value) || seen.has(value)) {
      continue
    }
    seen.add(value)
    resolved.push(value)
  }

  if (resolved.length > 0) return resolved

  return options.selectedAgentBackendIds !== undefined && raw.length === 0
    ? []
    : [defaultAgentBackendId]
}

const resolveRequiredAgentBackendBinaries = (
  options: HostToolsPreflightOptions,
): ReadonlyArray<{ readonly name: string; readonly installHint: string }> =>
  resolveRequiredAgentBackendIds(options).map((id) => BACKEND_HOST_TOOLS[id])

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
  const backendTools = resolveRequiredAgentBackendBinaries(options)
  const repositoryForges = resolveRepositoryForges(options)
  const forgeTools = repositoryForges.map((forge) => FORGE_HOST_TOOLS[forge])
  const hostTools: ReadonlyArray<HostTool> = [
    ...alwaysRequiredTools,
    ...forgeTools.map((tool) => ({ ...tool, required: true as const })),
    ...backendTools.map((tool) => ({ ...tool, required: true as const })),
    ...optionalTools,
  ]

  const missingRequired = hostTools.filter(
    (tool) => tool.required && !commandExists(tool.name),
  )

  if (missingRequired.length === 0) {
    return { ok: true }
  }

  const backendIds = resolveRequiredAgentBackendIds(options)
  const backendLabels = backendIds.map(
    (id) => getBuiltInAgentBackend(id)?.descriptor.label ?? id,
  )
  const backendSummary =
    backendLabels.length === 1
      ? backendLabels[0]
      : backendLabels.slice(0, -1).join(", ") +
        ` and ${backendLabels[backendLabels.length - 1]}`
  const requiredBaseTools = [
    "git",
    ...forgeTools.map((tool) => tool.name),
  ].join(" and ")

  const backendRequirement =
    backendIds.length === 0
      ? "No Agent Backend executable is required until one is selected in Settings."
      : `Only selected Agent Backend executable(s) (${backendSummary}) are required alongside ${requiredBaseTools}.`
  const lines = [
    "Required host tools are missing from PATH:",
    ...missingRequired.map((tool) => `  - ${tool.name}: ${tool.installHint}`),
    "",
    backendRequirement,
    "Install the tools above, then run ready-for-agent again.",
    "Keymaxxer is optional and does not block start.",
  ]

  return {
    ok: false,
    missing: missingRequired,
    message: lines.join("\n"),
  }
}
