import { sanitizeInheritedEnvironment } from "@ready-for-agent/agent-backend"

export type MakeCodexEnvironmentOptions = {
  readonly environment?: Readonly<Record<string, string | undefined>>
}

/**
 * Codex Build Agent Turns use ambient Forge authentication: inherit process
 * env (including ambient Forge tokens and OPENAI_API_KEY). Codex does not
 * support KeymaxxerMcp, so tokens are never stripped.
 */
export const makeCodexEnvironment = (
  options: MakeCodexEnvironmentOptions = {},
): Record<string, string> => {
  const environment =
    options.environment ?? (process.env as Record<string, string | undefined>)
  return sanitizeInheritedEnvironment(environment, {
    stripForgeTokens: false,
  })
}
