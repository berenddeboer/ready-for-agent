import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef } from "react"
import { followRepositoryIssuesLive } from "./refresh-issues-live.js"
import {
  issuesQuery,
  repositoriesQuery,
  workItemsQuery,
} from "./routes/index.js"
import { WorkItemsLiveUpdates } from "./work-items-live-updates.js"

/**
 * Mounts the Harness's existing live invalidation subscriptions for the
 * kanban board on `/`. Repository cards own these subscriptions on `/repos`;
 * the board mounts them without rendering repository management.
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

  return <WorkItemsLiveUpdates repositoryIds={repositoryIds} />
}
