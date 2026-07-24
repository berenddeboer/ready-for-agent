const isGitHubTokenEnvName = (name: string) =>
  name === "GH_TOKEN" ||
  name === "GITHUB_TOKEN" ||
  name.startsWith("GITHUB_TOKEN_")

/**
 * Inherit process environment with GitHub token variables stripped.
 * Adapters may merge additional backend-specific entries afterward.
 */
export const sanitizeInheritedEnvironment = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !isGitHubTokenEnvName(entry[0]),
    ),
  )
