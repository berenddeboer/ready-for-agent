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
 * Keeps Repository Issues and reconciliation metadata fresh via the
 * Issues-changed invalidation subscription, with reconnect and tab-visibility
 * refetch as fallback for missed ephemeral notifications.
 *
 * The subscription stays open across membership changes; callers supply the
 * current Repository IDs via `getRepositoryIds` so reconnect races cannot drop
 * a just-finished Refresh Job invalidation.
 */
export const followRepositoryIssuesLive = async ({
  getRepositoryIds,
  onRepositoryChanged,
  queryClient,
  queries,
  signal,
  stream = streamIssuesChanged,
  documentRef = typeof document === "undefined" ? undefined : document,
  retryDelayMs = 1_000,
}: {
  getRepositoryIds: () => readonly string[]
  onRepositoryChanged?: (repositoryId: string) => void
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

  const refreshWorkItems = async (repositoryId: string) => {
    const defaultQuery = queries.workItems(repositoryId)
    await queryClient.cancelQueries({
      queryKey: ["work-items", repositoryId],
    })
    const cached = queryClient
      .getQueryCache()
      .findAll({ queryKey: ["work-items", repositoryId] })
    if (cached.length === 0) {
      await fetchFresh(defaultQuery)
      return
    }
    await Promise.all(
      cached.map(async (query) => {
        const queryFn = query.options.queryFn
        if (typeof queryFn !== "function") return
        await queryClient.fetchQuery({
          queryKey: query.queryKey,
          queryFn: queryFn as (context: unknown) => Promise<unknown>,
          staleTime: 0,
        })
      }),
    )
  }

  const refresh = async (repositoryId: string) => {
    onRepositoryChanged?.(repositoryId)
    await Promise.all([
      fetchFresh(queries.repositories),
      fetchFresh(queries.issues(repositoryId)),
      refreshWorkItems(repositoryId),
    ])
  }

  const refreshAll = async () => {
    const repositoryIds = getRepositoryIds()
    await Promise.all([
      fetchFresh(queries.repositories),
      ...repositoryIds.map((repositoryId) =>
        fetchFresh(queries.issues(repositoryId)),
      ),
      ...repositoryIds.map((repositoryId) => refreshWorkItems(repositoryId)),
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
