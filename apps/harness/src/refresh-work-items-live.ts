import type { QueryClient } from "@tanstack/react-query"
import { streamWorkItemsChanged } from "./work-items-live.js"

export const committedPullRequestsCountQueryKeyPrefix = [
  "committed-pull-requests-count",
] as const

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
 * Refetches only the affected repository's workItems query on each event, and
 * also refetches active committed-pull-requests dashboard counts (global across
 * repositories) so the top strip stays live without polling.
 *
 * Per-event Work Item handling does not await count refresh, so the serial SSE
 * loop can process the next notification while a coalesced trailing count
 * refresh is still in flight. Connect and visibility still await counts.
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
    if (signal.aborted) return
    await queryClient.cancelQueries({ queryKey: query.queryKey, exact: true })
    if (signal.aborted) return
    return queryClient.fetchQuery({ ...query, staleTime: 0 })
  }

  const refreshCachedQueries = async (
    queryKey: readonly unknown[],
    { activeOnly = false }: { activeOnly?: boolean } = {},
  ) => {
    if (signal.aborted) return
    await queryClient.cancelQueries({ queryKey })
    if (signal.aborted) return
    const cached = queryClient.getQueryCache().findAll({ queryKey })
    const targets = activeOnly
      ? cached.filter((query) => query.isActive())
      : cached
    await Promise.all(
      targets.map(async (query) => {
        if (signal.aborted) return
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

  let committedCountsRefresh: Promise<void> | undefined
  let committedCountsRefreshPending = false
  let committedCountsRetryLoop: Promise<void> | undefined
  let fullRefreshRetryLoop: Promise<void> | undefined
  let fullRefreshPending = false

  const waitForRetryDelay = () =>
    new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve()
        return
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort)
        resolve()
      }, retryDelayMs)
      const onAbort = () => {
        clearTimeout(timer)
        resolve()
      }
      signal.addEventListener("abort", onAbort, { once: true })
    })

  /**
   * Refetch active committed-pull-requests-count windows (Today / Yesterday /
   * This week / Last week) observed by the mounted dashboard. Coalesces so a
   * burst of Work Item notifications shares one trailing aggregate refresh.
   *
   * Intermediate pass failures are swallowed so pending notifications still
   * drain. A failure on the final pass rejects so callers can retry or
   * reconnect. Abort stops further trailing passes.
   */
  const refreshCommittedPullRequestsCounts = (): Promise<void> => {
    if (signal.aborted) return Promise.resolve()
    committedCountsRefreshPending = true
    if (committedCountsRefresh !== undefined) return committedCountsRefresh

    committedCountsRefresh = (async () => {
      let lastError: unknown
      try {
        while (committedCountsRefreshPending && !signal.aborted) {
          committedCountsRefreshPending = false
          try {
            await refreshCachedQueries(
              committedPullRequestsCountQueryKeyPrefix,
              { activeOnly: true },
            )
            lastError = undefined
          } catch (error) {
            lastError = error
          }
        }
      } finally {
        committedCountsRefresh = undefined
      }
      if (signal.aborted) {
        committedCountsRefreshPending = false
        return
      }
      if (committedCountsRefreshPending) {
        await refreshCommittedPullRequestsCounts()
        return
      }
      if (lastError !== undefined) throw lastError
    })()

    return committedCountsRefresh
  }

  /**
   * Keep retrying count refresh until it succeeds or the follower aborts.
   * Used for detached event-path refreshes that cannot tear down the SSE
   * stream on failure.
   */
  const scheduleCommittedPullRequestsCounts = () => {
    if (signal.aborted) return
    if (committedCountsRetryLoop !== undefined) {
      // Ensure the running loop performs at least one more pass after the
      // current attempt (including while waiting out a backoff delay).
      committedCountsRefreshPending = true
      return
    }

    committedCountsRetryLoop = (async () => {
      try {
        while (!signal.aborted) {
          try {
            await refreshCommittedPullRequestsCounts()
            return
          } catch {
            await waitForRetryDelay()
          }
        }
      } finally {
        committedCountsRetryLoop = undefined
        if (committedCountsRefreshPending && !signal.aborted) {
          scheduleCommittedPullRequestsCounts()
        }
      }
    })()
  }

  /**
   * Refetch every work-items cache for the repository (default list plus any
   * Jobs Working/Failed/Completed listKind variants already in the query cache).
   */
  const refreshWorkItems = async (repositoryId: string) => {
    if (signal.aborted) return
    const defaultQuery = queries.workItems(repositoryId)
    const queryKey = ["work-items", repositoryId] as const
    const cached = queryClient.getQueryCache().findAll({ queryKey })
    if (cached.length === 0) {
      await fetchFresh(defaultQuery)
      return
    }
    await refreshCachedQueries(queryKey)
  }

  const refresh = async (repositoryId: string) => {
    // Do not await counts here: the SSE subscriber awaits each onChange, so
    // awaiting aggregates would serialize one full count refresh per event and
    // defeat coalescing under bursty lifecycle notifications.
    scheduleCommittedPullRequestsCounts()
    await refreshWorkItems(repositoryId)
  }

  const refreshAll = async () => {
    if (signal.aborted) return
    const repositoryIds = getRepositoryIds()
    await Promise.all([
      ...repositoryIds.map((repositoryId) => refreshWorkItems(repositoryId)),
      refreshCommittedPullRequestsCounts(),
    ])
  }

  const scheduleRefreshAll = () => {
    if (signal.aborted) return
    fullRefreshPending = true
    if (fullRefreshRetryLoop !== undefined) return

    fullRefreshRetryLoop = (async () => {
      try {
        while (!signal.aborted) {
          fullRefreshPending = false
          try {
            await refreshAll()
            if (!fullRefreshPending || signal.aborted) return
          } catch {
            await waitForRetryDelay()
          }
        }
      } finally {
        fullRefreshRetryLoop = undefined
        if (fullRefreshPending && !signal.aborted) {
          scheduleRefreshAll()
        }
      }
    })()
  }

  const refreshWhenVisible = () => {
    if (documentRef?.visibilityState === "visible") {
      scheduleRefreshAll()
    }
  }

  documentRef?.addEventListener("visibilitychange", refreshWhenVisible)

  const cancelOwnedQueries = () => {
    committedCountsRefreshPending = false
    fullRefreshPending = false
    void queryClient.cancelQueries({
      queryKey: committedPullRequestsCountQueryKeyPrefix,
    })
    void queryClient.cancelQueries({ queryKey: ["work-items"] })
  }
  signal.addEventListener("abort", cancelOwnedQueries, { once: true })

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
    signal.removeEventListener("abort", cancelOwnedQueries)
  }
}
