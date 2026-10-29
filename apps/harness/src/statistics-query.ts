import { createHarnessGraphqlClient } from "./harness-graphql.js"
import {
  UNKNOWN_MODEL_FILTER,
  timingHistoryQueryKey,
} from "./statistics-filters.js"
import {
  type StatisticsWindow,
  statisticsWindowBounds,
} from "./statistics-window.js"

const graphql = createHarnessGraphqlClient({ batch: true })

export function timingHistoryQuery(input: {
  readonly repositoryId: string
  readonly window: StatisticsWindow
  readonly agentBackend: string
  readonly model: string
}) {
  const unknownModel = input.model === UNKNOWN_MODEL_FILTER
  const bounds = statisticsWindowBounds(input.window)
  return {
    queryKey: timingHistoryQueryKey(input),
    staleTime: 60_000,
    refetchInterval: 60_000,
    queryFn: async () => {
      const result = await graphql.query({
        timingHistory: {
          __args: {
            repositoryId: input.repositoryId || undefined,
            from: bounds.from,
            to: bounds.to,
            agentBackend: input.agentBackend || undefined,
            model: unknownModel || input.model === "" ? undefined : input.model,
            unknownModel: unknownModel || undefined,
          },
          items: {
            id: true,
            repositoryId: true,
            repository: true,
            displayId: true,
            title: true,
            origin: true,
            agentBackend: true,
            models: true,
            modelHistory: true,
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
          choices: {
            agentBackends: true,
            models: {
              agentBackend: true,
              model: true,
            },
            hasUnknownModel: true,
          },
        },
      })
      return result.timingHistory
    },
  }
}

export type TimingHistoryPayload = Awaited<
  ReturnType<ReturnType<typeof timingHistoryQuery>["queryFn"]>
>
export type TimingWorkItem = TimingHistoryPayload["items"][number]
