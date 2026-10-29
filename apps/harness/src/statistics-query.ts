import { createHarnessGraphqlClient } from "./harness-graphql.js"
import {
  type StatisticsWindow,
  statisticsWindowBounds,
} from "./statistics-window.js"

const graphql = createHarnessGraphqlClient({ batch: true })

export function timingHistoryQuery(
  repositoryId: string,
  window: StatisticsWindow,
) {
  return {
    queryKey: ["timingHistory", repositoryId, window],
    staleTime: 60_000,
    refetchInterval: 60_000,
    queryFn: async () => {
      const result = await graphql.query({
        timingHistory: {
          __args: {
            repositoryId: repositoryId || undefined,
            ...statisticsWindowBounds(window),
          },
          id: true,
          repositoryId: true,
          repository: true,
          displayId: true,
          title: true,
          origin: true,
          createdAt: true,
          completedAt: true,
          attempts: {
            id: true,
            step: true,
            status: true,
            queuedAt: true,
            startedAt: true,
            finishedAt: true,
            sessionWaitMs: true,
            reasonCode: true,
          },
        },
      })
      return result.timingHistory
    },
  }
}

export type TimingWorkItem = Awaited<
  ReturnType<ReturnType<typeof timingHistoryQuery>["queryFn"]>
>[number]
