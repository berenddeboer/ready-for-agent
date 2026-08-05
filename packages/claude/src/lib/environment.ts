import { sanitizeInheritedEnvironment } from "@ready-for-agent/agent-backend"

export type MakeClaudeEnvironmentOptions = {
  readonly environment?: Readonly<Record<string, string | undefined>>
}

/**
 * Claude Code Agent Turns use ambient credentials: inherit process env
 * (Forge tokens, ANTHROPIC_API_KEY, and Amazon Bedrock / AWS credential
 * chain vars such as CLAUDE_CODE_USE_BEDROCK, AWS_ACCESS_KEY_ID,
 * AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, AWS_REGION / AWS_DEFAULT_REGION,
 * AWS_PROFILE, AWS_BEARER_TOKEN_BEDROCK). The shared sanitizer only strips
 * optional Forge tokens when requested; Claude never requests that strip, so
 * Bedrock enablement and AWS credentials reach inspect and turn spawns the
 * same way they would for a hand-run `claude` (issue #803 / epic #799).
 *
 * Force DISABLE_AUTOUPDATER so Harness operation cannot replace the CLI under
 * active work (ADR 0047). No Keymaxxer integration for Anthropic or AWS
 * secrets in v1.
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
