import type { QueryClient } from "@tanstack/react-query"
import { streamWorkItemsChanged } from "./work-items-live.js"

export type RepositoryWorkItemsLiveQueries = {
  workItems: (repositoryId: string) => {
    queryKey: readonly unknown[]
    queryFn: () => Promise<unknown>
  }
}

/**
 * Keeps Work Items fresh via the Work-Items-changed invalidation subscription,
 * with reconnect and tab-visibility refetch as fallback for missed ephemeral
 * notifications.
 *
 * Refetches only the affected repository's workItems query on each event.
 * Callers supply current Repository IDs via `getRepositoryIds` so reconnect
 * races still refresh newly added repositories.
 */
export const followRepositoryWorkItemsLive = async ({
  getRepositoryIds,
  queryClient,
  queries,
  signal,
  stream = streamWorkItemsChanged,
  documentRef = typeof document === "undefined" ? undefined : document,
  retryDelayMs = 1_000,
}: {
  getRepositoryIds: () => readonly string[]
  queryClient: QueryClient
  queries: RepositoryWorkItemsLiveQueries
  signal: AbortSignal
  stream?: typeof streamWorkItemsChanged
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

  /**
   * Refetch every work-items cache for the repository (default list plus any
   * Jobs Working/Failed/Completed listKind variants already in the query cache).
   */
  const refresh = async (repositoryId: string) => {
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

  const refreshAll = async () => {
    const repositoryIds = getRepositoryIds()
    await Promise.all(
      repositoryIds.map((repositoryId) => refresh(repositoryId)),
    )
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
