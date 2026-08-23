import { Data, type Duration, Effect } from "effect"
import {
  AZURE_DEVOPS_PAT_ENV_VAR,
  azureDevOpsVaultAccount,
} from "@ready-for-agent/azure-devops-service"
import {
  GitLabService,
  gitlabVaultAccount,
} from "@ready-for-agent/gitlab-service"
import {
  KeymaxxerService,
  type KeymaxxerServiceShape,
  keymaxxerError,
} from "@ready-for-agent/keymaxxer-service"
import { activateRepositoryPolling } from "./issue-polling.js"

/**
 * `forge` is untyped external data here (sourced from the persisted
 * Repository row via `DbService`, not the narrower literal union used by
 * `LocalRepository`/`AgentTurnForgeRepository`). Every switch below lists all
 * three known Forges explicitly and falls back to the historical
 * GitHub-first default for any unrecognized value, rather than relying on a
 * compile-time exhaustiveness check that plain `string` cannot provide.
 */
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

/** Suggested Keymaxxer secret name: `AZURE_DEVOPS_TOKEN_<ORG>_<PROJECT>`. */
export const azureDevOpsTokenSecretName = (repository: Repository) =>
  `AZURE_DEVOPS_TOKEN_${repository.projectPath}`
    .replace(/[^A-Za-z0-9_]/g, "_")
    .toUpperCase()

const tokenSecretName = (repository: Repository) => {
  switch (repository.forge) {
    case "gitlab":
      return gitlabTokenSecretName(repository)
    case "azure-devops":
      return azureDevOpsTokenSecretName(repository)
    // "github" and any unrecognized/legacy forge value both preserve the
    // historical GitHub-first fallback (`Repository.forge` is untyped
    // external data here, so this default cannot be a compile-time
    // exhaustiveness check the way the narrower literal-union forge types are).
    default:
      return githubTokenSecretName(repository)
  }
}

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

/** Organization-scoped Azure DevOps personal access token creation page. */
const azureDevOpsTokenCreationUrl = (repository: Repository) => {
  const [organization = ""] = repository.projectPath.split("/")
  return `https://dev.azure.com/${organization}/_usersSettings/tokens`
}

const tokenCreationUrl = (repository: Repository) => {
  switch (repository.forge) {
    case "gitlab":
      return gitlabTokenCreationUrl(repository)
    case "azure-devops":
      return azureDevOpsTokenCreationUrl(repository)
    default:
      return githubTokenCreationUrl(repository)
  }
}

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

/**
 * Whether the ambient `AZURE_DEVOPS_EXT_PAT` env var resolves. Azure DevOps
 * has no `az`-CLI shellout convention in this codebase (PAT-only auth,
 * unlike GitLab's `glab`), so — unlike `gitlabHasAmbientCredentialsBounded`,
 * which asks `GitLabService` — this is a direct env var check with no
 * service round-trip to bound.
 */
export const hasAzureDevOpsAmbientCredential = (): boolean => {
  const value = process.env[AZURE_DEVOPS_PAT_ENV_VAR]
  return typeof value === "string" && value.trim() !== ""
}

/** Distinguish a clean vault miss from Keymaxxer unavailable (see below). */
type VaultProbe =
  | { readonly kind: "secret"; readonly name: string }
  | { readonly kind: "miss" }
  | { readonly kind: "unavailable" }

const probeVaultSecret = (
  keymaxxer: KeymaxxerServiceShape,
  input: { readonly provider: string; readonly account: string },
  metadataTimeout: Duration.Duration | undefined,
): Effect.Effect<VaultProbe> => {
  const lookup = keymaxxer.findSecret(input)
  const timedLookup =
    metadataTimeout === undefined
      ? lookup
      : withKeymaxxerMetadataTimeout(lookup, metadataTimeout, "findSecret")
  return timedLookup.pipe(
    Effect.map(
      (name): VaultProbe =>
        name === null ? { kind: "miss" } : { kind: "secret", name },
    ),
    Effect.catchTag(
      "KeymaxxerError",
      (): Effect.Effect<VaultProbe> => Effect.succeed({ kind: "unavailable" }),
    ),
  )
}

/**
 * GitHub credential for Issue Polling: a vault secret, or ambient `gh` when
 * Keymaxxer is unavailable. A clean vault miss is not credentialed.
 */
export const githubRepositoryHasCredential = (
  keymaxxer: KeymaxxerServiceShape,
  projectPath: string,
  metadataTimeout?: Duration.Duration,
): Effect.Effect<boolean> =>
  probeVaultSecret(
    keymaxxer,
    { provider: "github", account: projectPath },
    metadataTimeout,
  ).pipe(Effect.map((probe) => probe.kind !== "miss"))

/** Activate durable Issue Polling only when this repository has forge credentials. */
export const activatePollingIfCredentialed = Effect.fn(
  "graphql-api.activatePollingIfCredentialed",
)(function* (
  repository: Repository,
  options?: { readonly metadataTimeout?: Duration.Duration },
) {
  const keymaxxer = yield* KeymaxxerService
  if (keymaxxer.enabled === false) {
    switch (repository.forge) {
      case "gitlab": {
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
      case "azure-devops": {
        if (hasAzureDevOpsAmbientCredential()) {
          yield* activateRepositoryPolling(repository.id)
        }
        return
      }
      // "github" and any unrecognized/legacy forge value both preserve the
      // historical GitHub-first fallback (no ambient check today).
      default: {
        yield* activateRepositoryPolling(repository.id)
        return
      }
    }
  }

  switch (repository.forge) {
    case "gitlab": {
      // Distinguish clean vault miss from Keymaxxer unavailable so we never
      // re-enter vault RPC after a timed-out probe — ambient-only path instead.
      const vaultProbe = yield* probeVaultSecret(
        keymaxxer,
        { provider: "gitlab", account: gitlabVaultAccount(repository) },
        options?.metadataTimeout,
      )
      if (vaultProbe.kind === "secret") {
        yield* activateRepositoryPolling(repository.id)
        return
      }
      // miss or unavailable: ambient only (no second vault findSecret).
      // Do not re-apply the full GraphQL metadata bound — vault already
      // consumed that budget; ambient glab/env has its own short path.
      if (yield* gitlabHasAmbientCredentialsBounded(repository)) {
        yield* activateRepositoryPolling(repository.id)
      }
      return
    }
    case "azure-devops": {
      const vaultProbe = yield* probeVaultSecret(
        keymaxxer,
        {
          provider: "azure-devops",
          account: azureDevOpsVaultAccount(repository),
        },
        options?.metadataTimeout,
      )
      if (vaultProbe.kind === "secret") {
        yield* activateRepositoryPolling(repository.id)
        return
      }
      // miss or unavailable: ambient AZURE_DEVOPS_EXT_PAT only, matching
      // GitLab's permissive fallback posture rather than GitHub's fail-closed
      // one (mirrors resolveAgentTurnForgeAuth's Agent Turn auth posture).
      if (hasAzureDevOpsAmbientCredential()) {
        yield* activateRepositoryPolling(repository.id)
      }
      return
    }
    // "github" and any unrecognized/legacy forge value: vault-first when
    // Keymaxxer can list secrets; a KeymaxxerError is unavailable and falls
    // back to ambient `gh`, matching GraphQL probeVaultSecret and the
    // disabled-Keymaxxer path. A clean miss still does not activate.
    default: {
      if (
        yield* githubRepositoryHasCredential(
          keymaxxer,
          repository.projectPath,
          options?.metadataTimeout,
        )
      ) {
        yield* activateRepositoryPolling(repository.id)
      }
      return
    }
  }
})
