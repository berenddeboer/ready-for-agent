/** Default Harness UI / GraphQL loopback origin (port 6056). */
export const DEFAULT_HARNESS_BASE_URL = "http://127.0.0.1:6056"

/** Single-line start remedy for unreachable-Harness failures. */
export const HARNESS_START_HINT = "Start it with: ready-for-agent start"

/**
 * Derive the operator-facing Harness base URL from a GraphQL endpoint URL
 * (strip a trailing `/graphql`). Falls back to the product default.
 */
export const harnessBaseUrlFromGraphqlUrl = (graphqlUrl: string): string => {
  const trimmed = graphqlUrl.trim().replace(/\/+$/, "")
  if (trimmed.length === 0) {
    return DEFAULT_HARNESS_BASE_URL
  }
  const withoutGraphql = trimmed.replace(/\/graphql$/i, "")
  return withoutGraphql.length > 0 ? withoutGraphql : DEFAULT_HARNESS_BASE_URL
}

/** User-facing message when the GraphQL target is the local Harness and it is down. */
export const harnessNotRunningMessage = (
  harnessBaseUrl: string = DEFAULT_HARNESS_BASE_URL,
): string =>
  `Harness is not running at ${harnessBaseUrl}\n${HARNESS_START_HINT}`

const collectErrorText = (cause: unknown): string => {
  const parts: string[] = []
  let current: unknown = cause
  for (
    let depth = 0;
    depth < 5 && current !== undefined && current !== null;
    depth++
  ) {
    if (current instanceof Error) {
      parts.push(current.message)
      current = current.cause
      continue
    }
    parts.push(String(current))
    break
  }
  return parts.join("\n")
}

export const isGraphqlUnreachable = (cause: unknown): boolean => {
  const text = collectErrorText(cause).toLowerCase()
  return (
    text.includes("econnrefused") ||
    text.includes("connection refused") ||
    text.includes("unable to connect") ||
    text.includes("fetch failed") ||
    text.includes("failed to fetch") ||
    text.includes("network error") ||
    text.includes("connecterror") ||
    text.includes("socket hang up") ||
    text.includes("enotfound")
  )
}

export type FormatGraphqlRequestFailureOptions = {
  /** Configured GraphQL URL; used to print the Harness origin when unreachable. */
  readonly graphqlUrl?: string
}

export const formatGraphqlRequestFailure = (
  cause: unknown,
  options?: FormatGraphqlRequestFailureOptions,
): string => {
  if (isGraphqlUnreachable(cause)) {
    const baseUrl =
      options?.graphqlUrl === undefined
        ? DEFAULT_HARNESS_BASE_URL
        : harnessBaseUrlFromGraphqlUrl(options.graphqlUrl)
    return harnessNotRunningMessage(baseUrl)
  }
  return cause instanceof Error ? cause.message : "GraphQL request failed"
}
