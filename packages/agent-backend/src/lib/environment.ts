const isGitHubTokenEnvName = (name: string) =>
  name === "GH_TOKEN" ||
  name === "GITHUB_TOKEN" ||
  name.startsWith("GITHUB_TOKEN_")

const isGitLabTokenEnvName = (name: string) => name.startsWith("GITLAB_TOKEN")

/**
 * Harness operational names that must never reach an Agent Turn or Interactive
 * Session Continuation. Always stripped, independent of Forge-token options.
 */
export const HARNESS_OWNED_ENVIRONMENT_NAMES = [
  "SQLITE_DATABASE_PATH",
  "KEYMAXXER_SIDECAR_URL",
  "KEYMAXXER_SIDECAR_PORT",
  "KEYMAXXER_ENABLED",
  "KEYMAXXER_MASTER_KEY",
  "KEYMAXXER_APPROVE",
  "READY_FOR_AGENT_GRAPHQL_URL",
] as const

const harnessOwnedEnvironmentNameSet = new Set<string>(
  HARNESS_OWNED_ENVIRONMENT_NAMES,
)

const isHarnessOwnedEnvironmentName = (name: string) =>
  harnessOwnedEnvironmentNameSet.has(name)

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
 * Inherit process environment, dropping undefined entries. Always strip
 * Harness-owned operational names. Optionally strip Forge token variables when
 * the backend receives vault-backed credentials.
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
        !isHarnessOwnedEnvironmentName(entry[0]) &&
        !(stripGitHubTokens && isGitHubTokenEnvName(entry[0])) &&
        !(stripGitLabTokens && isGitLabTokenEnvName(entry[0])),
    ),
  )
}
