/**
 * Shared Harness Config query for Home and Harness Settings.
 *
 * Lives outside any single route module so Settings chrome and Repository
 * settings share one cache shape without importing each other. Callers pass
 * their own GraphQL client so batching policy stays local.
 */

import type { createHarnessGraphqlClient } from "./harness-graphql.js"

export const configQueryKey = ["config"] as const

export const configSelection = {
  selectedAgentBackend: true,
  defaultModel: true,
  defaultThinkingLevel: true,
  reviewModel: true,
  reviewThinkingLevel: true,
  maxConcurrentAgentTurns: true,
  maxConcurrentWorkItems: true,
  unfinishedWorkItemCount: true,
  blockingUnfinishedWorkItemCount: true,
} as const

export const createConfigQuery = (
  graphql: Pick<ReturnType<typeof createHarnessGraphqlClient>, "query">,
) => ({
  queryKey: configQueryKey,
  queryFn: async () => {
    const result = await graphql.query({
      config: configSelection,
    })
    return result.config
  },
})
