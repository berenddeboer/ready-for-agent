import { Schema } from "effect"

export class GitHubRepositoryUnavailableError extends Schema.TaggedErrorClass<GitHubRepositoryUnavailableError>()(
  "GitHubRepositoryUnavailableError",
  {
    forge: Schema.String,
    forgeHost: Schema.String,
    projectPath: Schema.String,
  },
) {}

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

export type GitHubServiceError =
  | GitHubRepositoryUnavailableError
  | GitHubRequestError
  | GitHubThrottledError
