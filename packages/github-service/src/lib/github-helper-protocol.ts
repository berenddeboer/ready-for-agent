/**
 * Machine-readable control records written by GitHub helpers to stderr.
 *
 * Helper stdout remains the operation's existing data contract. Stderr carries
 * this separate, deliberately tiny control plane so a parent can distinguish
 * an explicit GitHub throttle from a human-oriented command failure without
 * receiving credential material.
 */
export const GITHUB_HELPER_PROTOCOL_VERSION = 1 as const
export const GITHUB_HELPER_THROTTLED_EXIT_CODE = 3 as const
/** Typed helper exit used by the Keymaxxer parent to invalidate auth caches. */
export const GITHUB_HELPER_AUTHENTICATION_EXIT_CODE = 4 as const

export interface GitHubHelperThrottle {
  readonly retryAt: number
  readonly usedFallback: boolean
}

export interface GitHubHelperSuccess {
  readonly version: typeof GITHUB_HELPER_PROTOCOL_VERSION
  readonly kind: "success"
  /** Present only when a successful response exhausted the final quota. */
  readonly throttle: GitHubHelperThrottle | null
}

export interface GitHubHelperThrottled {
  readonly version: typeof GITHUB_HELPER_PROTOCOL_VERSION
  readonly kind: "github-throttled"
  readonly retryAt: number
  readonly usedFallback: boolean
}

export type GitHubHelperControl = GitHubHelperSuccess | GitHubHelperThrottled

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const isThrottle = (value: unknown): value is GitHubHelperThrottle =>
  isRecord(value) &&
  typeof value.retryAt === "number" &&
  Number.isSafeInteger(value.retryAt) &&
  value.retryAt > 0 &&
  typeof value.usedFallback === "boolean"

/**
 * Strictly recognizes only the current helper protocol. Unknown, malformed,
 * and future records deliberately produce `undefined`: callers must treat
 * them as ordinary helper failures, never as a guessed throttle.
 */
export const parseGitHubHelperControl = (
  text: string,
): GitHubHelperControl | undefined => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (
    !isRecord(value) ||
    value.version !== GITHUB_HELPER_PROTOCOL_VERSION ||
    typeof value.kind !== "string"
  ) {
    return undefined
  }
  if (value.kind === "success") {
    if (value.throttle !== null && !isThrottle(value.throttle)) return undefined
    return {
      version: GITHUB_HELPER_PROTOCOL_VERSION,
      kind: "success",
      throttle: value.throttle,
    }
  }
  if (value.kind === "github-throttled" && isThrottle(value)) {
    return {
      version: GITHUB_HELPER_PROTOCOL_VERSION,
      kind: "github-throttled",
      retryAt: value.retryAt,
      usedFallback: value.usedFallback,
    }
  }
  return undefined
}

/** This serializer accepts only non-secret protocol fields. */
export const serializeGitHubHelperControl = (
  value: GitHubHelperControl,
): string => JSON.stringify(value)

export const githubHelperSuccess = (input?: {
  readonly throttle?: GitHubHelperThrottle
}): GitHubHelperSuccess => ({
  version: GITHUB_HELPER_PROTOCOL_VERSION,
  kind: "success",
  throttle:
    input?.throttle === undefined
      ? null
      : {
          retryAt: input.throttle.retryAt,
          usedFallback: input.throttle.usedFallback,
        },
})

export const githubHelperThrottled = (
  throttle: GitHubHelperThrottle,
): GitHubHelperThrottled => ({
  version: GITHUB_HELPER_PROTOCOL_VERSION,
  kind: "github-throttled",
  retryAt: throttle.retryAt,
  usedFallback: throttle.usedFallback,
})
