import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef } from "react"
import { followRepositoryWorkItemsLive } from "./refresh-work-items-live.js"
import { workItemsQuery } from "./routes/index.js"

/**
 * Mounts Work Item live invalidation for board/archive routes that do not
 * render Repository cards (those cards own the subscriptions on Home).
 * Refreshes per-repo work-items caches and the historical completed-work-items
 * archive when repositoryWorkItemsChanged fires.
 */
export function WorkItemsLiveUpdates({
  repositoryIds,
}: {
  readonly repositoryIds: readonly string[]
}) {
  const queryClient = useQueryClient()
  const repositoryIdsRef = useRef(repositoryIds)
  repositoryIdsRef.current = repositoryIds

  useEffect(() => {
    const controller = new AbortController()
    void followRepositoryWorkItemsLive({
      getRepositoryIds: () => repositoryIdsRef.current,
      queryClient,
      queries: {
        workItems: workItemsQuery,
      },
      signal: controller.signal,
    })
    return () => controller.abort()
  }, [queryClient])

  return null
}
