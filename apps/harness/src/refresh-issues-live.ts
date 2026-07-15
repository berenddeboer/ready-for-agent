import type { QueryClient } from "@tanstack/react-query"
import { streamIssuesChanged } from "./issues-live.js"

export type RepositoryIssuesLiveQueries = {
  repositories: {
    queryKey: readonly unknown[]
    queryFn: () => Promise<unknown>
  }
  issues: (repositoryId: string) => {
    queryKey: readonly unknown[]
    queryFn: () => Promise<unknown>
  }
  workItems: (repositoryId: string) => {
    queryKey: readonly unknown[]
    queryFn: () => Promise<unknown>
  }
}

/**
 * Keeps a Repository's Issues and reconciliation metadata fresh via the
 * Issues-changed invalidation subscription, with reconnect and tab-visibility
 * refetch as fallback for missed ephemeral notifications.
 */
export const followRepositoryIssuesLive = async ({
  repositoryIds,
  queryClient,
  queries,
  signal,
  stream = streamIssuesChanged,
  documentRef = typeof document === "undefined" ? undefined : document,
  retryDelayMs = 1_000,
}: {
  repositoryIds: readonly string[]
  queryClient: QueryClient
  queries: RepositoryIssuesLiveQueries
  signal: AbortSignal
  stream?: typeof streamIssuesChanged
  documentRef?: Pick<
    Document,
    "visibilityState" | "addEventListener" | "removeEventListener"
  >
  retryDelayMs?: number
}): Promise<void> => {
  const fetchFresh = async (query: {
    queryKey: readonly unknown[]
    queryFn: () => Promise<unknown>
  }) => {
    await queryClient.cancelQueries({ queryKey: query.queryKey, exact: true })
    return queryClient.fetchQuery({ ...query, staleTime: 0 })
  }

  const refresh = async (repositoryId: string) => {
    await Promise.all([
      fetchFresh(queries.repositories),
      fetchFresh(queries.issues(repositoryId)),
      fetchFresh(queries.workItems(repositoryId)),
    ])
  }

  const refreshAll = async () => {
    await Promise.all([
      fetchFresh(queries.repositories),
      ...repositoryIds.map((repositoryId) =>
        fetchFresh(queries.issues(repositoryId)),
      ),
      ...repositoryIds.map((repositoryId) =>
        fetchFresh(queries.workItems(repositoryId)),
      ),
    ])
  }

  const refreshWhenVisible = () => {
    if (documentRef?.visibilityState === "visible") {
      void refreshAll().catch(() => undefined)
    }
  }

  documentRef?.addEventListener("visibilitychange", refreshWhenVisible)

  try {
    while (!signal.aborted) {
      const attempt = new AbortController()
      const onAbort = () => attempt.abort()
      signal.addEventListener("abort", onAbort, { once: true })
      try {
        await stream({
          signal: attempt.signal,
          onConnected: refreshAll,
          onChange: refresh,
        })
      } catch {
        if (signal.aborted) return
      } finally {
        signal.removeEventListener("abort", onAbort)
        attempt.abort()
      }

      if (signal.aborted) return
      await new Promise<void>((resolve) => {
        const finish = () => {
          signal.removeEventListener("abort", cancel)
          resolve()
        }
        const timer = setTimeout(finish, retryDelayMs)
        const cancel = () => {
          clearTimeout(timer)
          finish()
        }
        signal.addEventListener("abort", cancel, { once: true })
      })
    }
  } finally {
    documentRef?.removeEventListener("visibilitychange", refreshWhenVisible)
  }
}
