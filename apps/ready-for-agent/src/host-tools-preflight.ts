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
}

const alwaysRequiredTools: ReadonlyArray<HostTool> = [
  {
    name: "git",
    installHint: "Install Git: https://git-scm.com/downloads",
    required: true,
  },
  {
    name: "gh",
    installHint: "Install GitHub CLI (gh): https://cli.github.com/",
    required: true,
  },
]

const optionalTools: ReadonlyArray<HostTool> = [
  {
    name: "keymaxxer",
    installHint:
      "Keymaxxer is optional. Install when you want vault-backed secrets; ambient GitHub auth still works without it.",
    required: false,
  },
]

export type HostToolsPreflightOptions = {
  /**
   * Selected Agent Backend ids that cold-start preflight must cover
   * (harness default ∪ Repository overrides). Unknown ids are ignored.
   * Combined with {@link selectedAgentBackendId} when both are set; if neither
   * yields a selectable id, OpenCode is required.
   */
  readonly selectedAgentBackendIds?: ReadonlyArray<string>
  /**
   * Single selected backend id (legacy convenience). Prefer
   * {@link selectedAgentBackendIds} when multiple backends may be selected.
   * Merged into the required set when present (including when the plural list
   * is empty).
   */
  readonly selectedAgentBackendId?: string
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

  return resolved.length > 0 ? resolved : [defaultAgentBackendId]
}

const resolveRequiredAgentBackendBinaries = (
  options: HostToolsPreflightOptions,
): ReadonlyArray<{ readonly name: string; readonly installHint: string }> =>
  resolveRequiredAgentBackendIds(options).map((id) => BACKEND_HOST_TOOLS[id])

export const checkHostTools = (
  commandExists: (command: string) => boolean,
  options: HostToolsPreflightOptions = {},
): HostToolsPreflightResult => {
  const backendTools = resolveRequiredAgentBackendBinaries(options)
  const hostTools: ReadonlyArray<HostTool> = [
    ...alwaysRequiredTools,
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

  const lines = [
    "Required host tools are missing from PATH:",
    ...missingRequired.map((tool) => `  - ${tool.name}: ${tool.installHint}`),
    "",
    `Only selected Agent Backend executable(s) (${backendSummary}) are required alongside git and gh.`,
    "Install the tools above, then run ready-for-agent again.",
    "Keymaxxer is optional and does not block start.",
  ]

  return {
    ok: false,
    missing: missingRequired,
    message: lines.join("\n"),
  }
}
