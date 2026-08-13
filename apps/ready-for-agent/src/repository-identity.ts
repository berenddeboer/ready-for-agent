/**
 * Parse and match CLI Repository selectors against configured Repositories.
 * Explicit host://path and host/path forms outrank project-path shorthands.
 */

const DISALLOWED_SELECTOR_SCHEMES = new Set(["http", "https", "ssh", "git"])

export type RepositoryIdentityFields = {
  readonly id: string
  readonly forgeHost: string
  readonly projectPath: string
}

export type ParsedRepositorySelector =
  | {
      readonly _tag: "explicit_host_path"
      readonly selector: string
      readonly forgeHost: string
      readonly projectPath: string
    }
  | {
      readonly _tag: "host_or_project_path"
      readonly selector: string
      readonly forgeHost: string
      readonly projectPath: string
    }
  | {
      readonly _tag: "project_name"
      readonly selector: string
      readonly projectName: string
    }
  | { readonly _tag: "invalid"; readonly argument: string }

export type RepositoryIdentityMatch<T extends RepositoryIdentityFields> =
  | { readonly _tag: "matched"; readonly repository: T }
  | { readonly _tag: "not_found"; readonly selector: string }
  | {
      readonly _tag: "ambiguous"
      readonly selector: string
      readonly matches: readonly T[]
    }
  | { readonly _tag: "invalid"; readonly argument: string }

const fold = (value: string): string => value.toLowerCase()

const hasLeadingOrTrailingSlash = (value: string): boolean =>
  value.startsWith("/") || value.endsWith("/")

const finalProjectPathSegment = (projectPath: string): string => {
  const slash = projectPath.lastIndexOf("/")
  return slash === -1 ? projectPath : projectPath.slice(slash + 1)
}

export const formatRepositoryFullIdentity = (
  repository: Pick<RepositoryIdentityFields, "forgeHost" | "projectPath">,
): string => `${repository.forgeHost}://${repository.projectPath}`

const identitySortKey = (repository: RepositoryIdentityFields): string =>
  `${fold(repository.forgeHost)}://${fold(repository.projectPath)}\0${repository.id}`

const orderedMatches = <T extends RepositoryIdentityFields>(
  matches: readonly T[],
): T[] =>
  [...matches].sort((left, right) =>
    identitySortKey(left).localeCompare(identitySortKey(right)),
  )

const decideMatches = <T extends RepositoryIdentityFields>(
  selector: string,
  matches: readonly T[],
): RepositoryIdentityMatch<T> => {
  const ordered = orderedMatches(matches)
  const [repository, ...rest] = ordered
  if (repository === undefined) {
    return { _tag: "not_found", selector }
  }
  if (rest.length === 0) {
    return { _tag: "matched", repository }
  }
  return { _tag: "ambiguous", selector, matches: ordered }
}

const matchesHostAndPath = <T extends RepositoryIdentityFields>(
  repositories: readonly T[],
  forgeHost: string,
  projectPath: string,
): T[] => {
  const hostKey = fold(forgeHost)
  const pathKey = fold(projectPath)
  return repositories.filter(
    (repository) =>
      fold(repository.forgeHost) === hostKey &&
      fold(repository.projectPath) === pathKey,
  )
}

/**
 * Classify a Repository selector. Does not accept clone/web URL schemes.
 * Values without a slash are project-name selectors, not opaque Repository IDs.
 */
export const parseRepositoryIdentityArgument = (
  argument: string,
): ParsedRepositorySelector => {
  const selector = argument.trim()
  if (selector.length === 0) {
    return { _tag: "invalid", argument }
  }

  const schemeSeparator = selector.indexOf("://")
  if (schemeSeparator >= 0) {
    const forgeHost = selector.slice(0, schemeSeparator).trim()
    const projectPath = selector.slice(schemeSeparator + 3).trim()
    if (
      forgeHost.length === 0 ||
      DISALLOWED_SELECTOR_SCHEMES.has(fold(forgeHost)) ||
      projectPath.length === 0 ||
      hasLeadingOrTrailingSlash(projectPath)
    ) {
      return { _tag: "invalid", argument }
    }
    return {
      _tag: "explicit_host_path",
      selector,
      forgeHost,
      projectPath,
    }
  }

  if (hasLeadingOrTrailingSlash(selector)) {
    return { _tag: "invalid", argument }
  }

  const slash = selector.indexOf("/")
  if (slash === -1) {
    return {
      _tag: "project_name",
      selector,
      projectName: selector,
    }
  }

  const forgeHost = selector.slice(0, slash).trim()
  const projectPath = selector.slice(slash + 1).trim()
  if (
    forgeHost.length === 0 ||
    projectPath.length === 0 ||
    hasLeadingOrTrailingSlash(projectPath)
  ) {
    return { _tag: "invalid", argument }
  }
  return {
    _tag: "host_or_project_path",
    selector,
    forgeHost,
    projectPath,
  }
}

/**
 * Match one configured Repository by explicit identity or unique shorthand.
 * Matching is case-insensitive; display casing is preserved on the match.
 */
export const resolveRepositoryIdentity = <T extends RepositoryIdentityFields>(
  argument: string,
  repositories: readonly T[],
): RepositoryIdentityMatch<T> => {
  const parsed = parseRepositoryIdentityArgument(argument)
  switch (parsed._tag) {
    case "invalid":
      return parsed
    case "explicit_host_path":
      return decideMatches(
        parsed.selector,
        matchesHostAndPath(repositories, parsed.forgeHost, parsed.projectPath),
      )
    case "host_or_project_path": {
      const hostPathMatches = matchesHostAndPath(
        repositories,
        parsed.forgeHost,
        parsed.projectPath,
      )
      if (hostPathMatches.length > 0) {
        return decideMatches(parsed.selector, hostPathMatches)
      }
      const pathKey = fold(parsed.selector)
      return decideMatches(
        parsed.selector,
        repositories.filter(
          (repository) => fold(repository.projectPath) === pathKey,
        ),
      )
    }
    case "project_name": {
      const nameKey = fold(parsed.projectName)
      return decideMatches(
        parsed.selector,
        repositories.filter(
          (repository) =>
            fold(finalProjectPathSegment(repository.projectPath)) === nameKey,
        ),
      )
    }
    default: {
      const _exhaustive: never = parsed
      return _exhaustive
    }
  }
}
