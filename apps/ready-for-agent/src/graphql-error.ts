export const HARNESS_START_HINT =
  "Start the Harness first: ready-for-agent start (or bun run ready-for-agent start)"

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

export const formatGraphqlRequestFailure = (cause: unknown): string => {
  const detail =
    cause instanceof Error ? cause.message : "GraphQL request failed"
  if (isGraphqlUnreachable(cause)) {
    return `${detail}\n\n${HARNESS_START_HINT}`
  }
  return detail
}
