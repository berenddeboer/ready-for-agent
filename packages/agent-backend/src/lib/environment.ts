const isGitHubTokenEnvName = (name: string) =>
  name === "GH_TOKEN" ||
  name === "GITHUB_TOKEN" ||
  name.startsWith("GITHUB_TOKEN_")

const isGitLabTokenEnvName = (name: string) => name.startsWith("GITLAB_TOKEN")

export type SanitizeInheritedEnvironmentOptions = {
  /**
   * When true (default), strip GitHub and GitLab token variables.
   * Set false when the backend is not receiving vault-backed Keymaxxer MCP so
   * ambient Forge authentication remains available to Agent Turns.
   */
  readonly stripForgeTokens?: boolean
  /**
   * Override GitHub token stripping independently from other Forges.
   */
  readonly stripGitHubTokens?: boolean
  /**
   * Override GitLab token stripping independently from other Forges.
   */
  readonly stripGitLabTokens?: boolean
}

/**
 * Inherit process environment, dropping undefined entries. Optionally strip
 * Forge token variables when the backend receives vault-backed credentials.
 */
export const sanitizeInheritedEnvironment = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  options: SanitizeInheritedEnvironmentOptions = {},
): Record<string, string> => {
  const stripGitHubTokens =
    options.stripGitHubTokens ?? options.stripForgeTokens ?? true
  const stripGitLabTokens =
    options.stripGitLabTokens ?? options.stripForgeTokens ?? true
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !(stripGitHubTokens && isGitHubTokenEnvName(entry[0])) &&
        !(stripGitLabTokens && isGitLabTokenEnvName(entry[0])),
    ),
  )
}
