import type { QueryClient } from "@tanstack/react-query"

/**
 * How often the UI re-fetches GitHub-authoritative open non-draft PR counts
 * while the tab is visible. External PR changes do not emit Work Item SSE
 * events, so Work Item invalidation alone cannot keep the header count live.
 */
export const OPEN_PULL_REQUEST_COUNT_POLL_INTERVAL_MS = 120_000

/**
 * Dedicated TanStack Query cache identity for GitHub-authoritative open
 * non-draft Pull Request counts. Independent of the Configured Repositories
 * projection so count latency cannot cancel, block, or invalidate Repository
 * cards, credentials, Issues, Work Items, or controls.
 */
export const openPullRequestCountsQueryKey = [
  "open-pull-request-counts",
] as const

export type OpenPullRequestCountLiveQuery = {
  readonly queryKey: readonly unknown[]
  readonly queryFn: () => Promise<unknown>
}

/**
 * Header presentation for one Repository's open non-draft PR count.
 *
 * A missing per-repo value is loading whenever the dedicated projection is
 * pending or fetching (e.g. after add-repository while a stale map still
 * lacks the new id). "Unavailable" only applies when the query is settled
 * without a count for that Repository.
 */
export const openPullRequestCountPresentation = ({
  count,
  isPending,
  isFetching,
}: {
  readonly count: number | undefined
  readonly isPending: boolean
  readonly isFetching: boolean
}): {
  readonly label: string
  readonly display: string
  readonly loading: boolean
} => {
  if (count !== undefined) {
    return {
      label:
        count === 1 ? "1 open pull request" : `${count} open pull requests`,
      display: String(count),
      loading: false,
    }
  }
  const loading = isPending || isFetching
  if (loading) {
    return {
      label: "Loading open pull requests",
      display: "…",
      loading: true,
    }
  }
  return {
    label: "Open pull requests unavailable",
    display: "—",
    loading: false,
  }
}

/**
 * Keeps the dedicated open Pull Request count projection current via
 * GitHub-backed refetch: periodic polling while the tab is visible, plus an
 * immediate refetch when a backgrounded tab becomes visible again.
 *
 * Refreshes only the dedicated count query identity. Never cancels,
 * invalidates, fetches, or awaits the main Configured Repositories query.
 *
 * Transient fetch failures are swallowed so a single GraphQL/network blip does
 * not tear down the poller; the next poll tick or visibility event retries.
 */
export const followOpenPullRequestCountLive = async ({
  queryClient,
  openPullRequestCountsQuery,
  signal,
  documentRef = typeof document === "undefined" ? undefined : document,
  pollIntervalMs = OPEN_PULL_REQUEST_COUNT_POLL_INTERVAL_MS,
}: {
  queryClient: QueryClient
  openPullRequestCountsQuery: OpenPullRequestCountLiveQuery
  signal: AbortSignal
  documentRef?: Pick<
    Document,
    "visibilityState" | "addEventListener" | "removeEventListener"
  >
  pollIntervalMs?: number
}): Promise<void> => {
  const refresh = async () => {
    if (signal.aborted) return
    try {
      await queryClient.cancelQueries({
        queryKey: openPullRequestCountsQuery.queryKey,
        exact: true,
      })
      if (signal.aborted) return
      await queryClient.fetchQuery({
        ...openPullRequestCountsQuery,
        staleTime: 0,
      })
    } catch {
      // Keep the follower alive; the next poll or visibility event will retry.
    }
  }

  const refreshWhenVisible = () => {
    if (documentRef?.visibilityState === "visible") {
      void refresh()
    }
  }

  documentRef?.addEventListener("visibilitychange", refreshWhenVisible)

  try {
    // Catch up immediately on connect (e.g. after remount).
    if (
      documentRef === undefined ||
      documentRef.visibilityState === "visible"
    ) {
      await refresh()
    }

    while (!signal.aborted) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          signal.removeEventListener("abort", cancel)
          resolve()
        }
        const timer = setTimeout(finish, pollIntervalMs)
        const cancel = () => {
          clearTimeout(timer)
          finish()
        }
        signal.addEventListener("abort", cancel, { once: true })
      })
      if (signal.aborted) return
      if (
        documentRef === undefined ||
        documentRef.visibilityState === "visible"
      ) {
        await refresh()
      }
    }
  } finally {
    documentRef?.removeEventListener("visibilitychange", refreshWhenVisible)
    void queryClient.cancelQueries({
      queryKey: openPullRequestCountsQuery.queryKey,
      exact: true,
    })
  }
}
