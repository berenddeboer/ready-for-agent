import { sanitizeInheritedEnvironment } from "@ready-for-agent/agent-backend"

export type MakeCodexEnvironmentOptions = {
  readonly environment?: Readonly<Record<string, string | undefined>>
}

/**
 * Codex Build Agent Turns use ambient Forge authentication: inherit process
 * env (including ambient Forge tokens, OPENAI_API_KEY, and CODEX_HOME).
 * Codex does not support KeymaxxerMcp, so Forge tokens are never stripped.
 * Harness-owned operational names are still stripped by the shared sanitizer.
 * Custom provider credentials stay in Codex-owned config; inspect does not
 * execute provider token commands.
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
