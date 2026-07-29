import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef } from "react"
import { followRepositoryIssuesLive } from "./refresh-issues-live.js"
import { followRepositoryWorkItemsLive } from "./refresh-work-items-live.js"
import {
  issuesQuery,
  repositoriesQuery,
  workItemsQuery,
} from "./routes/index.js"

/**
 * Mounts the Harness's existing live invalidation subscriptions for the
 * board-only route. Repository cards normally own these subscriptions on the
 * dashboard, so /kanban mounts them without rendering repository management.
 */
export function KanbanLiveUpdates({
  repositoryIds,
}: {
  readonly repositoryIds: readonly string[]
}) {
  const queryClient = useQueryClient()
  const repositoryIdsRef = useRef(repositoryIds)
  repositoryIdsRef.current = repositoryIds

  useEffect(() => {
    const controller = new AbortController()
    void followRepositoryIssuesLive({
      getRepositoryIds: () => repositoryIdsRef.current,
      queryClient,
      queries: {
        repositories: repositoriesQuery,
        issues: issuesQuery,
        workItems: workItemsQuery,
      },
      signal: controller.signal,
    })
    return () => controller.abort()
  }, [queryClient])

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
