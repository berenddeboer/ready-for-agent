import { Schema } from "effect"

export class GitHubRepositoryUnavailableError extends Schema.TaggedErrorClass<GitHubRepositoryUnavailableError>()(
  "GitHubRepositoryUnavailableError",
  {
    forge: Schema.String,
    forgeHost: Schema.String,
    projectPath: Schema.String,
    /**
     * Viewer login for the token that could not see the Repository, when
     * resolved. Same identity can produce GitHub's NOT_FOUND for a private
     * repo the account cannot access.
     */
    authenticatedLogin: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
  },
) {}

/** Operator-facing copy when a token cannot see a Repository. */
export const formatGitHubRepositoryUnavailableMessage = (
  projectPath: string,
  authenticatedLogin: string,
): string =>
  `${projectPath} is not visible to GitHub user ${authenticatedLogin} — it may not exist, or that account may not have access`

export class GitHubRequestError extends Schema.TaggedErrorClass<GitHubRequestError>()(
  "GitHubRequestError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    statusCode: Schema.optional(Schema.Finite),
    /**
     * Machine-readable discriminator lifted from the nested cause chain
     * (e.g. `SELF_SIGNED_CERT_IN_CHAIN`, `ENOTFOUND`) when available.
     */
    code: Schema.optional(Schema.String),
    /** Whether the transport failure may receive the bounded query retry. */
    retryable: Schema.optional(Schema.Boolean),
  },
) {}

/**
 * Permanent TLS certificate trust failure talking to the GitHub API host.
 * Not retryable for the process lifetime (missing private CA / MITM root).
 */
export class GitHubTlsTrustError extends Schema.TaggedErrorClass<GitHubTlsTrustError>()(
  "GitHubTlsTrustError",
  {
    message: Schema.String,
    /** API hostname that failed trust (typically api.github.com). */
    host: Schema.String,
    /** OpenSSL / Node TLS error code (e.g. SELF_SIGNED_CERT_IN_CHAIN). */
    code: Schema.String,
    /** Issuer O/CN when preflight could read the presented chain. */
    issuer: Schema.optional(Schema.NullOr(Schema.String)),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * Explicit, non-secret GitHub flow-control evidence. `retryAt` is epoch
 * milliseconds so a process-local coordinator and GraphQL can share it without
 * locale or clock-format ambiguity.
 */
export class GitHubThrottledError extends Schema.TaggedErrorClass<GitHubThrottledError>()(
  "GitHubThrottledError",
  {
    retryAt: Schema.Finite,
    /** True only when GitHub omitted a secondary-limit deadline. */
    usedFallback: Schema.Boolean,
  },
) {}

export const isGitHubThrottledError = (
  value: unknown,
): value is GitHubThrottledError =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === "GitHubThrottledError"

export const isGitHubTlsTrustError = (
  value: unknown,
): value is GitHubTlsTrustError =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === "GitHubTlsTrustError"

export const isGitHubRequestError = (
  value: unknown,
): value is GitHubRequestError =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === "GitHubRequestError"

/** HTTP 403 permission (secret too narrow). Distinct from 401 authentication. */
export const isGitHubPermissionError = (
  value: unknown,
): value is GitHubRequestError =>
  isGitHubRequestError(value) && value.statusCode === 403

/** Confirmed GitHub 4xx that did not start the requested mutation. */
export const isGitHubClientRejection = (value: unknown): boolean => {
  if (!isGitHubRequestError(value)) {
    return false
  }
  const status = value.statusCode
  return (
    typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 400 &&
    status < 500
  )
}

export type GitHubServiceError =
  | GitHubRepositoryUnavailableError
  | GitHubRequestError
  | GitHubTlsTrustError
  | GitHubThrottledError
