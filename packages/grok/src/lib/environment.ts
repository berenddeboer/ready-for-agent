import { sanitizeInheritedEnvironment } from "@ready-for-agent/agent-backend"

export type MakeGrokEnvironmentOptions = {
  readonly environment?: Readonly<Record<string, string | undefined>>
}

/**
 * Grok Build Agent Turns use ambient Forge authentication: inherit process env
 * (including ambient Forge tokens), and force auto-update off for the process
 * lifetime. Grok does not support KeymaxxerMcp, so Forge tokens are never
 * stripped. Harness-owned operational names are still stripped by the shared
 * sanitizer.
 */
export const makeGrokEnvironment = (
  options: MakeGrokEnvironmentOptions = {},
): Record<string, string> => {
  const environment =
    options.environment ?? (process.env as Record<string, string | undefined>)
  return {
    ...sanitizeInheritedEnvironment(environment, {
      stripForgeTokens: false,
    }),
    GROK_DISABLE_AUTOUPDATER: "1",
  }
}
