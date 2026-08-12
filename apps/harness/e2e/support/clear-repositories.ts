/**
 * Clear leftover Repositories so multi-scenario live e2e can share one
 * Harness process (issue #995). Setup Givens call this through GraphQL
 * and do not navigate home or Repos to prove the add-Repository blank slate.
 * Retries briefly when remove is blocked by a still-running Step Run or
 * Refresh Job.
 */

import { E2E_GRAPHQL_URL } from "./constants.ts"

export class GraphQlRequestError extends Error {
  readonly codes: ReadonlyArray<string>

  constructor(messages: ReadonlyArray<string>, codes: ReadonlyArray<string>) {
    super(`GraphQL errors: ${messages.join("; ")}`)
    this.name = "GraphQlRequestError"
    this.codes = codes
  }
}

export type E2eGraphqlRequest = <T>(
  query: string,
  variables?: Record<string, unknown>,
) => Promise<T>

export type ClearRepositoriesClient = {
  readonly listRepositoryIds: () => Promise<ReadonlyArray<string>>
  readonly removeRepository: (repositoryId: string) => Promise<void>
}

const CLEAR_REPOSITORIES_TIMEOUT_MS = 30_000
const CLEAR_REPOSITORIES_RETRY_MS = 500

export const graphqlRequest: E2eGraphqlRequest = async <T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> => {
  const response = await fetch(E2E_GRAPHQL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  })
  if (!response.ok) {
    throw new Error(`GraphQL HTTP ${response.status}: ${await response.text()}`)
  }
  const payload: unknown = await response.json()
  if (typeof payload !== "object" || payload === null) {
    throw new Error("GraphQL response was not an object")
  }
  const errors = "errors" in payload ? payload.errors : undefined
  if (Array.isArray(errors) && errors.length > 0) {
    const messages: string[] = []
    const codes: string[] = []
    for (const entry of errors) {
      if (typeof entry !== "object" || entry === null) {
        messages.push(String(entry))
        codes.push("")
        continue
      }
      messages.push(
        "message" in entry && typeof entry.message === "string"
          ? entry.message
          : String(entry),
      )
      const extensions =
        "extensions" in entry &&
        typeof entry.extensions === "object" &&
        entry.extensions !== null
          ? entry.extensions
          : undefined
      codes.push(
        extensions !== undefined &&
          "code" in extensions &&
          typeof extensions.code === "string"
          ? extensions.code
          : "",
      )
    }
    throw new GraphQlRequestError(messages, codes)
  }
  if (
    !("data" in payload) ||
    payload.data === undefined ||
    payload.data === null
  ) {
    throw new Error("GraphQL response missing data")
  }
  return payload.data as T
}

export const liveClearRepositoriesClient = (
  graphql: E2eGraphqlRequest = graphqlRequest,
): ClearRepositoriesClient => ({
  listRepositoryIds: async () => {
    const listed = await graphql<{
      repositories: ReadonlyArray<{ id: string }>
    }>(`query { repositories { id } }`)
    return listed.repositories.map((repository) => repository.id)
  },
  removeRepository: async (repositoryId) => {
    await graphql(
      `mutation RemoveRepository($repositoryId: ID!) {
        removeRepository(repositoryId: $repositoryId)
      }`,
      { repositoryId },
    )
  },
})

const classifyRemoveRepositoryError = (
  error: unknown,
): "step-run" | "refresh-job" | "other" => {
  const message = error instanceof Error ? error.message : String(error)
  const codes = error instanceof GraphQlRequestError ? error.codes : []
  if (
    codes.includes("REPOSITORY_HAS_RUNNING_STEP") ||
    /REPOSITORY_HAS_RUNNING_STEP/i.test(message) ||
    /has a running Step Run/i.test(message) ||
    /RepositoryHasRunningStep/i.test(message)
  ) {
    return "step-run"
  }
  // Refresh Jobs do not have a dedicated remove block. Contention shows up as
  // a lock while the job writes the Issue store — not every DATABASE_ERROR.
  if (
    /Refresh Job/i.test(message) ||
    /SQLITE_BUSY/i.test(message) ||
    /database is locked/i.test(message)
  ) {
    return "refresh-job"
  }
  return "other"
}

export const ensureNoConfiguredRepositories = async (input?: {
  readonly client?: ClearRepositoriesClient
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  readonly timeoutMs?: number
  readonly retryIntervalMs?: number
}): Promise<void> => {
  const client = input?.client ?? liveClearRepositoriesClient()
  const now = input?.now ?? Date.now
  const sleep =
    input?.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const timeoutMs = input?.timeoutMs ?? CLEAR_REPOSITORIES_TIMEOUT_MS
  const retryIntervalMs = input?.retryIntervalMs ?? CLEAR_REPOSITORIES_RETRY_MS
  const deadline = now() + timeoutMs
  let attempt = 0

  while (true) {
    attempt += 1
    const listed = await client.listRepositoryIds()
    if (listed.length === 0) {
      return
    }

    let blocked = false
    let blockedKind: "step-run" | "refresh-job" | "unknown" = "unknown"
    const failures: string[] = []
    for (const repositoryId of listed) {
      try {
        await client.removeRepository(repositoryId)
      } catch (error) {
        const kind = classifyRemoveRepositoryError(error)
        if (kind !== "other") {
          blocked = true
          blockedKind = kind
          failures.push(error instanceof Error ? error.message : String(error))
          continue
        }
        throw error
      }
    }

    // When no remove was classified as blocked, re-list and return only if
    // empty; otherwise retry until the deadline (blocked path re-lists at
    // the top of the next loop iteration).
    if (!blocked) {
      const remaining = await client.listRepositoryIds()
      if (remaining.length === 0) {
        return
      }
    }

    if (now() >= deadline) {
      const reason =
        blockedKind === "step-run"
          ? "because a Step Run is still running"
          : blockedKind === "refresh-job"
            ? "because a Refresh Job is still running"
            : "after remove mutations"
      throw new Error(
        [
          "Could not clear configured Repositories",
          reason,
          `(after ${attempt} attempts over ~${Math.round(timeoutMs / 1000)}s).`,
          "Multi-scenario e2e shares one Harness process; wait for refresh/work",
          "to finish, or restart the e2e webServer.",
          ...failures,
        ].join(" "),
      )
    }
    await sleep(retryIntervalMs)
  }
}
