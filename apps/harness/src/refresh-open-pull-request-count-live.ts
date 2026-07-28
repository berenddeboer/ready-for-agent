import type { QueryClient } from "@tanstack/react-query"

/**
 * How often the UI re-fetches GitHub-authoritative open non-draft PR counts
 * while the tab is visible. External PR changes do not emit Work Item SSE
 * events, so Work Item invalidation alone cannot keep the header count live.
 */
export const OPEN_PULL_REQUEST_COUNT_POLL_INTERVAL_MS = 30_000

export type OpenPullRequestCountLiveQuery = {
  readonly queryKey: readonly unknown[]
  readonly queryFn: () => Promise<unknown>
}

/**
 * Keeps `Repository.pullRequestCount` current via GitHub-backed repositories
 * query refetch: periodic polling while the tab is visible, plus an immediate
 * refetch when a backgrounded tab becomes visible again.
 *
 * Transient fetch failures are swallowed so a single GraphQL/network blip does
 * not tear down the poller; the next poll tick or visibility event retries.
 */
export const followOpenPullRequestCountLive = async ({
  queryClient,
  repositoriesQuery,
  signal,
  documentRef = typeof document === "undefined" ? undefined : document,
  pollIntervalMs = OPEN_PULL_REQUEST_COUNT_POLL_INTERVAL_MS,
}: {
  queryClient: QueryClient
  repositoriesQuery: OpenPullRequestCountLiveQuery
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
        queryKey: repositoriesQuery.queryKey,
        exact: true,
      })
      if (signal.aborted) return
      await queryClient.fetchQuery({
        ...repositoriesQuery,
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
      queryKey: repositoriesQuery.queryKey,
      exact: true,
    })
  }
}
