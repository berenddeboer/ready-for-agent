export type HostTool = {
  readonly name: string
  readonly installHint: string
  readonly required: boolean
}

export const HOST_TOOLS: ReadonlyArray<HostTool> = [
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
  {
    name: "opencode",
    installHint: "Install OpenCode: https://opencode.ai",
    required: true,
  },
  {
    name: "keymaxxer",
    installHint:
      "Keymaxxer is optional. Install when you want vault-backed secrets; ambient GitHub auth still works without it.",
    required: false,
  },
]

export type HostToolsPreflightResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly missing: ReadonlyArray<HostTool>
      readonly message: string
    }

export const checkHostTools = (
  commandExists: (command: string) => boolean,
): HostToolsPreflightResult => {
  const missingRequired = HOST_TOOLS.filter(
    (tool) => tool.required && !commandExists(tool.name),
  )

  if (missingRequired.length === 0) {
    return { ok: true }
  }

  const lines = [
    "Required host tools are missing from PATH:",
    ...missingRequired.map((tool) => `  - ${tool.name}: ${tool.installHint}`),
    "",
    "Install the tools above, then run ready-for-agent again.",
    "Keymaxxer is optional and does not block start.",
  ]

  return {
    ok: false,
    missing: missingRequired,
    message: lines.join("\n"),
  }
}
