import { Data, type Duration, Effect } from "effect"
import {
  GitLabService,
  gitlabVaultAccount,
} from "@ready-for-agent/gitlab-service"
import {
  KeymaxxerService,
  keymaxxerError,
} from "@ready-for-agent/keymaxxer-service"
import { activateRepositoryPolling } from "./issue-polling.js"

export type Repository = {
  id: string
  forge: string
  forgeHost: string
  projectPath: string
}

export class RepositoryCredentialError extends Data.TaggedError(
  "RepositoryCredentialError",
)<{ readonly message: string }> {}

export const githubTokenSecretName = (repository: Repository) =>
  `GITHUB_TOKEN_${repository.projectPath}`
    .replace(/[^A-Za-z0-9_]/g, "_")
    .toUpperCase()

/** Suggested Keymaxxer secret name: `GITLAB_TOKEN_<HOST>_<PATH>`. */
export const gitlabTokenSecretName = (repository: Repository) =>
  `GITLAB_TOKEN_${repository.forgeHost}_${repository.projectPath}`
    .replace(/[^A-Za-z0-9_]/g, "_")
    .toUpperCase()

const tokenSecretName = (repository: Repository) =>
  repository.forge === "gitlab"
    ? gitlabTokenSecretName(repository)
    : githubTokenSecretName(repository)

const githubTokenCreationUrl = (repository: Repository) => {
  const [owner = "", name = ""] = repository.projectPath.split("/")
  const url = new URL("https://github.com/settings/personal-access-tokens/new")
  url.searchParams.set("name", `rfa - ${name}`)
  url.searchParams.set(
    "description",
    `Ready For Agent token for ${repository.projectPath}`,
  )
  url.searchParams.set("target_name", owner)
  url.searchParams.set("expires_in", "90")
  url.searchParams.set("issues", "write")
  url.searchParams.set("contents", "write")
  url.searchParams.set("pull_requests", "write")
  // Actions write enables workflow reruns and job-log reads. Workflows write
  // is a separate permission required to push `.github/workflows/**`.
  // Commit statuses help with CI visibility. Per-check CheckRun nodes need Checks
  // API access, which fine-grained PATs cannot grant — see AGENTS.md.
  url.searchParams.set("actions", "write")
  url.searchParams.set("workflows", "write")
  url.searchParams.set("statuses", "read")
  return url.toString()
}

/** Instance-correct GitLab personal access token creation page. */
const gitlabTokenCreationUrl = (repository: Repository) =>
  `https://${repository.forgeHost}/-/user_settings/personal_access_tokens`

const tokenCreationUrl = (repository: Repository) =>
  repository.forge === "gitlab"
    ? gitlabTokenCreationUrl(repository)
    : githubTokenCreationUrl(repository)

export const repositoryCredential = (
  repository: Repository,
  existingToken: string | null,
  configured = existingToken !== null,
) => ({
  repositoryId: repository.id,
  configured,
  // Field names are historical (GitHub-first) but hold the active Forge's
  // suggested or configured vault secret name and creation URL.
  githubTokenSecretName: existingToken ?? tokenSecretName(repository),
  githubTokenCreationUrl: tokenCreationUrl(repository),
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

/**
 * Probe ambient GitLab credentials (no vault re-entry) with an optional wait bound.
 *
 * After GraphQL already paid for vault metadata (miss or timeout), ambient-only
 * Repositories must not re-enter Keymaxxer findSecret.
 */
export const gitlabHasAmbientCredentialsBounded = (
  repository: Repository,
  metadataTimeout?: Duration.Duration,
) =>
  Effect.gen(function* () {
    const gitlab = yield* GitLabService
    const check = gitlab.hasAmbientCredentials(repository)
    if (metadataTimeout === undefined) {
      return yield* check
    }
    return yield* check.pipe(
      Effect.timeout(metadataTimeout),
      Effect.catchTag("TimeoutError", () => Effect.succeed(false)),
    )
  })

/** Activate durable Issue Polling only when this repository has forge credentials. */
export const activatePollingIfCredentialed = Effect.fn(
  "graphql-api.activatePollingIfCredentialed",
)(function* (
  repository: Repository,
  options?: { readonly metadataTimeout?: Duration.Duration },
) {
  const keymaxxer = yield* KeymaxxerService
  if (keymaxxer.enabled === false) {
    if (repository.forge === "gitlab") {
      if (
        yield* gitlabHasAmbientCredentialsBounded(
          repository,
          options?.metadataTimeout,
        )
      ) {
        yield* activateRepositoryPolling(repository.id)
      }
      return
    }
    yield* activateRepositoryPolling(repository.id)
    return
  }

  if (repository.forge === "gitlab") {
    const lookup = keymaxxer.findSecret({
      provider: "gitlab",
      account: gitlabVaultAccount(repository),
    })
    // Distinguish clean vault miss from Keymaxxer unavailable so we never
    // re-enter vault RPC after a timed-out probe — ambient-only path instead.
    type VaultProbe =
      | { readonly kind: "secret"; readonly name: string }
      | { readonly kind: "miss" }
      | { readonly kind: "unavailable" }
    const timedLookup =
      options?.metadataTimeout === undefined
        ? lookup
        : withKeymaxxerMetadataTimeout(
            lookup,
            options.metadataTimeout,
            "findSecret",
          )
    const vaultProbe: VaultProbe = yield* timedLookup.pipe(
      Effect.map(
        (name): VaultProbe =>
          name === null ? { kind: "miss" } : { kind: "secret", name },
      ),
      Effect.catchTag(
        "KeymaxxerError",
        (): Effect.Effect<VaultProbe> =>
          Effect.succeed({ kind: "unavailable" }),
      ),
    )
    if (vaultProbe.kind === "secret") {
      yield* activateRepositoryPolling(repository.id)
      return
    }
    // miss or unavailable: ambient only (no second vault findSecret).
    // Do not re-apply the full GraphQL metadata bound — vault already consumed
    // that budget; ambient glab/env has its own short path.
    if (yield* gitlabHasAmbientCredentialsBounded(repository)) {
      yield* activateRepositoryPolling(repository.id)
    }
    return
  }

  const lookup = keymaxxer.findSecret({
    provider: "github",
    account: repository.projectPath,
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
