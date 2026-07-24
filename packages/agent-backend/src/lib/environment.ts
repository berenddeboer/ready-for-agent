const isGitHubTokenEnvName = (name: string) =>
  name === "GH_TOKEN" ||
  name === "GITHUB_TOKEN" ||
  name.startsWith("GITHUB_TOKEN_")

export type SanitizeInheritedEnvironmentOptions = {
  /**
   * When true (default), strip GH_TOKEN / GITHUB_TOKEN / GITHUB_TOKEN_*.
   * Set false when the backend is not receiving vault-backed Keymaxxer MCP so
   * ambient GitHub authentication remains available to Agent Turns.
   */
  readonly stripGitHubTokens?: boolean
}

/**
 * Inherit process environment, dropping undefined entries. Optionally strip
 * GitHub token variables when the backend receives vault-backed credentials.
 */
export const sanitizeInheritedEnvironment = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  options: SanitizeInheritedEnvironmentOptions = {},
): Record<string, string> => {
  const stripGitHubTokens = options.stripGitHubTokens !== false
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !(stripGitHubTokens && isGitHubTokenEnvName(entry[0])),
    ),
  )
}
