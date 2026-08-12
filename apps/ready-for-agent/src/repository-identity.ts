/**
 * Parse and match explicit CLI Repository identity
 * `<forge-host>/<project-path>` (case-insensitive, unique).
 */

export type ParsedRepositoryIdentity = {
  readonly forgeHost: string
  readonly projectPath: string
}

export type RepositoryIdentityMatch<
  T extends {
    readonly id: string
    readonly forgeHost: string
    readonly projectPath: string
  },
> =
  | { readonly _tag: "matched"; readonly repository: T }
  | {
      readonly _tag: "not_found"
      readonly forgeHost: string
      readonly projectPath: string
    }
  | {
      readonly _tag: "ambiguous"
      readonly forgeHost: string
      readonly projectPath: string
      readonly matchCount: number
    }
  | { readonly _tag: "invalid"; readonly argument: string }

/**
 * Split at the first slash. Host and project path must both be non-empty.
 * Does not accept an opaque Repository ID.
 */
export const parseRepositoryIdentityArgument = (
  argument: string,
): ParsedRepositoryIdentity | null => {
  const trimmed = argument.trim()
  const slash = trimmed.indexOf("/")
  if (slash <= 0 || slash === trimmed.length - 1) {
    return null
  }
  const forgeHost = trimmed.slice(0, slash).trim()
  const projectPath = trimmed.slice(slash + 1).trim()
  if (forgeHost.length === 0 || projectPath.length === 0) {
    return null
  }
  return { forgeHost, projectPath }
}

const fold = (value: string): string => value.toLowerCase()

/**
 * Match one configured Repository by forge host + project path.
 * Matching is case-insensitive; display casing is preserved on the match.
 */
export const resolveRepositoryIdentity = <
  T extends {
    readonly id: string
    readonly forgeHost: string
    readonly projectPath: string
  },
>(
  argument: string,
  repositories: readonly T[],
): RepositoryIdentityMatch<T> => {
  const parsed = parseRepositoryIdentityArgument(argument)
  if (parsed === null) {
    return { _tag: "invalid", argument }
  }
  const hostKey = fold(parsed.forgeHost)
  const pathKey = fold(parsed.projectPath)
  const matches = repositories.filter(
    (repository) =>
      fold(repository.forgeHost) === hostKey &&
      fold(repository.projectPath) === pathKey,
  )
  if (matches.length === 0) {
    return {
      _tag: "not_found",
      forgeHost: parsed.forgeHost,
      projectPath: parsed.projectPath,
    }
  }
  if (matches.length > 1) {
    return {
      _tag: "ambiguous",
      forgeHost: parsed.forgeHost,
      projectPath: parsed.projectPath,
      matchCount: matches.length,
    }
  }
  const repository = matches[0]
  if (repository === undefined) {
    return {
      _tag: "not_found",
      forgeHost: parsed.forgeHost,
      projectPath: parsed.projectPath,
    }
  }
  return { _tag: "matched", repository }
}
