import { Data, Effect } from "effect"
import { KeymaxxerService } from "@ready-for-agent/keymaxxer-service"
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

export const githubTokenCreationUrl = (repository: Repository) => {
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
  // Actions + commit statuses help with CI visibility. Per-check CheckRun nodes
  // need Checks API access, which fine-grained PATs cannot grant — see AGENTS.md.
  url.searchParams.set("actions", "read")
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

/** Activate durable Issue Polling only when a GitHub token is already configured. */
export const activatePollingIfCredentialed = Effect.fn(
  "graphql-api.activatePollingIfCredentialed",
)(function* (repository: Repository) {
  const keymaxxer = yield* KeymaxxerService
  if (keymaxxer.enabled === false) {
    yield* activateRepositoryPolling(repository.id)
    return
  }
  const credential = yield* keymaxxer.findSecret({
    provider: "github",
    account: `${repository.githubOwner}/${repository.githubRepo}`,
  })
  if (credential === null) return
  yield* activateRepositoryPolling(repository.id)
})
