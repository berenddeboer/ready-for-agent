import { sanitizeInheritedEnvironment } from "@ready-for-agent/agent-backend"

export type MakeGrokEnvironmentOptions = {
  readonly environment?: Readonly<Record<string, string | undefined>>
}

/**
 * Grok Build Agent Turns use ambient `gh` only: sanitize inherited env, strip
 * raw GitHub tokens, and force auto-update off for the process lifetime.
 */
export const makeGrokEnvironment = (
  options: MakeGrokEnvironmentOptions = {},
): Record<string, string> => {
  const environment =
    options.environment ?? (process.env as Record<string, string | undefined>)
  return {
    ...sanitizeInheritedEnvironment(environment),
    GROK_DISABLE_AUTOUPDATER: "1",
  }
}
