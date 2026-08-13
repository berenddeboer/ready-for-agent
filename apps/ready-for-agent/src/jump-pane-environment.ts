import { sanitizeInheritedEnvironment } from "@ready-for-agent/agent-backend"

/**
 * tmux owns these in the pane. Forwarding the CLI process copies would
 * override pane identity (`TMUX_PANE`) and ignore `-c` for cwd.
 */
const tmuxOwnedOrProcessLocalEnvNames = new Set([
  "TMUX",
  "TMUX_PANE",
  "TERM",
  "PWD",
  "OLDPWD",
  "SHLVL",
  "_",
])

export const jumpPaneEnvironmentFlags = (input: {
  readonly backendId: string
}): string[] => {
  const inherited = sanitizeInheritedEnvironment(process.env, {
    stripForgeTokens: false,
  })
  if (input.backendId === "claude") {
    inherited.DISABLE_AUTOUPDATER = "1"
  }
  const flags: string[] = []
  for (const name of Object.keys(inherited).sort()) {
    if (tmuxOwnedOrProcessLocalEnvNames.has(name)) {
      continue
    }
    const value = inherited[name]
    if (value === undefined) {
      continue
    }
    flags.push("-e", `${name}=${value}`)
  }
  return flags
}
