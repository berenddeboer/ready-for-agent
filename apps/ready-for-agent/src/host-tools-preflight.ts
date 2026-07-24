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
  /** Active/selected Agent Backend id; defaults to OpenCode. */
  readonly selectedAgentBackendId?: string
}

export type HostToolsPreflightResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly missing: ReadonlyArray<HostTool>
      readonly message: string
    }

const resolveRequiredAgentBackendBinary = (
  selectedAgentBackendId?: string,
): { readonly name: string; readonly installHint: string } => {
  const id =
    selectedAgentBackendId !== undefined &&
    isSelectableAgentBackendId(selectedAgentBackendId)
      ? selectedAgentBackendId
      : defaultAgentBackendId
  return BACKEND_HOST_TOOLS[id]
}

export const checkHostTools = (
  commandExists: (command: string) => boolean,
  options: HostToolsPreflightOptions = {},
): HostToolsPreflightResult => {
  const backendTool = resolveRequiredAgentBackendBinary(
    options.selectedAgentBackendId,
  )
  const hostTools: ReadonlyArray<HostTool> = [
    ...alwaysRequiredTools,
    { ...backendTool, required: true },
    ...optionalTools,
  ]

  const missingRequired = hostTools.filter(
    (tool) => tool.required && !commandExists(tool.name),
  )

  if (missingRequired.length === 0) {
    return { ok: true }
  }

  const backendLabel =
    getBuiltInAgentBackend(
      options.selectedAgentBackendId !== undefined &&
        isSelectableAgentBackendId(options.selectedAgentBackendId)
        ? options.selectedAgentBackendId
        : defaultAgentBackendId,
    )?.descriptor.label ?? "the selected Agent Backend"

  const lines = [
    "Required host tools are missing from PATH:",
    ...missingRequired.map((tool) => `  - ${tool.name}: ${tool.installHint}`),
    "",
    `Only the selected Agent Backend executable (${backendLabel}) is required alongside git and gh.`,
    "Install the tools above, then run ready-for-agent again.",
    "Keymaxxer is optional and does not block start.",
  ]

  return {
    ok: false,
    missing: missingRequired,
    message: lines.join("\n"),
  }
}
