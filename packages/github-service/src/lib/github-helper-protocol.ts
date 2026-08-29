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
/**
 * Permanent TLS certificate trust failure. Non-secret host + OpenSSL code only;
 * the parent rebuilds operator-facing remediation (no API/token material).
 */
export const GITHUB_HELPER_TLS_TRUST_EXIT_CODE = 5 as const
/**
 * Typed helper exit for HTTP 403 permission (secret too narrow). Distinct from
 * 401 authentication so the parent can speak without reading helper output.
 */
export const GITHUB_HELPER_PERMISSION_EXIT_CODE = 6 as const

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

/** Non-secret TLS trust evidence for the Keymaxxer parent. */
export interface GitHubHelperTlsTrust {
  readonly version: typeof GITHUB_HELPER_PROTOCOL_VERSION
  readonly kind: "github-tls-trust"
  readonly host: string
  readonly code: string
}

export type GitHubHelperControl =
  | GitHubHelperSuccess
  | GitHubHelperThrottled
  | GitHubHelperTlsTrust

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const isThrottle = (value: unknown): value is GitHubHelperThrottle =>
  isRecord(value) &&
  typeof value.retryAt === "number" &&
  Number.isSafeInteger(value.retryAt) &&
  value.retryAt > 0 &&
  typeof value.usedFallback === "boolean"

const isTlsTrustFields = (
  value: Record<string, unknown>,
): value is { readonly host: string; readonly code: string } =>
  typeof value.host === "string" &&
  value.host.trim() !== "" &&
  typeof value.code === "string" &&
  value.code.trim() !== ""

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
  if (value.kind === "github-tls-trust" && isTlsTrustFields(value)) {
    return {
      version: GITHUB_HELPER_PROTOCOL_VERSION,
      kind: "github-tls-trust",
      host: value.host.trim(),
      code: value.code.trim(),
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

export const githubHelperTlsTrust = (input: {
  readonly host: string
  readonly code: string
}): GitHubHelperTlsTrust => ({
  version: GITHUB_HELPER_PROTOCOL_VERSION,
  kind: "github-tls-trust",
  host: input.host,
  code: input.code,
})
