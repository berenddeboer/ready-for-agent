import { sanitizeInheritedEnvironment } from "@ready-for-agent/agent-backend"

export type MakeClaudeEnvironmentOptions = {
  readonly environment?: Readonly<Record<string, string | undefined>>
}

/**
 * Claude Code Agent Turns use ambient Forge authentication: inherit process
 * env (including ambient Forge tokens and ANTHROPIC_API_KEY). Force
 * DISABLE_AUTOUPDATER so Harness operation cannot replace the CLI under active
 * work (ADR 0047). Claude does not support KeymaxxerMcp, so tokens are never
 * stripped.
 */
export const makeClaudeEnvironment = (
  options: MakeClaudeEnvironmentOptions = {},
): Record<string, string> => {
  const environment =
    options.environment ?? (process.env as Record<string, string | undefined>)
  return {
    ...sanitizeInheritedEnvironment(environment, {
      stripForgeTokens: false,
    }),
    DISABLE_AUTOUPDATER: "1",
  }
}
