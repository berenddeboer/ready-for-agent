import { Data, type Duration, Effect } from "effect"
import {
  KeymaxxerService,
  keymaxxerError,
} from "@ready-for-agent/keymaxxer-service"
import { activateRepositoryPolling } from "./issue-polling.js"

export type Repository = {
  id: string
  githubOwner: string
  githubRepo: string
}

export class RepositoryCredentialError extends Data.TaggedError(
  "RepositoryCredentialError",
)<{ readonly message: string }> {}

export const githubTokenSecretName = (repository: Repository) =>
  `GITHUB_TOKEN_${repository.githubOwner}_${repository.githubRepo}`
    .replace(/[^A-Za-z0-9_]/g, "_")
    .toUpperCase()

const githubTokenCreationUrl = (repository: Repository) => {
  const url = new URL("https://github.com/settings/personal-access-tokens/new")
  url.searchParams.set("name", `${repository.githubRepo} - ready-for-agent`)
  url.searchParams.set(
    "description",
    `Ready For Agent token for ${repository.githubOwner}/${repository.githubRepo}`,
  )
  url.searchParams.set("target_name", repository.githubOwner)
  url.searchParams.set("expires_in", "90")
  url.searchParams.set("issues", "write")
  url.searchParams.set("contents", "write")
  url.searchParams.set("pull_requests", "write")
  // Actions write enables workflow reruns; read covers CI visibility and job logs.
  // Commit statuses help with CI visibility. Per-check CheckRun nodes need Checks
  // API access, which fine-grained PATs cannot grant — see AGENTS.md.
  url.searchParams.set("actions", "write")
  url.searchParams.set("statuses", "read")
  return url.toString()
}

export const repositoryCredential = (
  repository: Repository,
  existingToken: string | null,
  configured = existingToken !== null,
) => ({
  repositoryId: repository.id,
  configured,
  githubTokenSecretName: existingToken ?? githubTokenSecretName(repository),
  githubTokenCreationUrl: githubTokenCreationUrl(repository),
})

/**
 * Bound a GraphQL-facing Keymaxxer metadata effect.
 *
 * This is a **client-side** wait bound: the GraphQL fiber fails with an
 * actionable error so the Harness UI unblocks. The underlying MCP/`tryPromise`
 * Keymaxxer call is not aborted, so the Sidecar dialog lane may still be
 * occupied until the operator dismisses the dialog or Keymaxxer returns.
 * Plumbing AbortSignal through the HTTP MCP client is a separate change.
 */
export const withKeymaxxerMetadataTimeout = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  timeout: Duration.Duration,
  operation = "metadata",
): Effect.Effect<A, E | ReturnType<typeof keymaxxerError>, R> =>
  effect.pipe(
    Effect.timeout(timeout),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        keymaxxerError(
          operation,
          "Keymaxxer did not respond in time (waiting for vault unlock or secret-use approval)",
        ),
      ),
    ),
  )

/** Activate durable Issue Polling only when a GitHub token is already configured. */
export const activatePollingIfCredentialed = Effect.fn(
  "graphql-api.activatePollingIfCredentialed",
)(function* (
  repository: Repository,
  options?: { readonly metadataTimeout?: Duration.Duration },
) {
  const keymaxxer = yield* KeymaxxerService
  if (keymaxxer.enabled === false) {
    yield* activateRepositoryPolling(repository.id)
    return
  }
  const lookup = keymaxxer.findSecret({
    provider: "github",
    account: `${repository.githubOwner}/${repository.githubRepo}`,
  })
  const credential =
    options?.metadataTimeout === undefined
      ? yield* lookup
      : yield* withKeymaxxerMetadataTimeout(
          lookup,
          options.metadataTimeout,
          "findSecret",
        )
  if (credential === null) return
  yield* activateRepositoryPolling(repository.id)
})
