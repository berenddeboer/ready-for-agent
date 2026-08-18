/**
 * Shared Configured Repositories list query for root chrome, Jobs filters,
 * board routes, and live membership followers.
 *
 * Lives outside any single route module so sticky chrome can gate on membership
 * without importing the home route.
 */

import { createHarnessGraphqlClient } from "./harness-graphql.js"

const graphql = createHarnessGraphqlClient({ batch: true })

type RepositoryCredential = {
  repositoryId: string
  configured: boolean
  githubTokenSecretName: string
  githubTokenCreationUrl: string
}

export type Repository = {
  id: string
  forge: string
  forgeHost: string
  projectPath: string
  localPath: string
  isBare: boolean
  paused: boolean
  selectedAgentBackend: string | null
  effectiveAgentBackend: string
  defaultModel: string | null
  defaultThinkingLevel: string | null
  reviewModel: string | null
  reviewThinkingLevel: string | null
  mergePolicy: "OFF" | "CLASSIFY" | "ALWAYS"
  includeAllIssueAuthors: boolean
  waitForReadyForReviewChecks: boolean
  issuesReconciledAt: string | null
  blockingUnfinishedWorkItemCount: number
  credential: RepositoryCredential
}

export const repositoriesQuery = {
  queryKey: ["repositories"] as const,
  queryFn: async (): Promise<readonly Repository[]> => {
    // Intentionally omits pullRequestCount: GitHub-authoritative open non-draft
    // PR counting is a dedicated projection (openPullRequestCountsQuery) so
    // Keymaxxer-backed count latency cannot delay Configured Repositories,
    // credentials, Issues, Work Items, or controls.
    const result = await graphql.query({
      repositories: {
        id: true,
        forge: true,
        forgeHost: true,
        projectPath: true,
        localPath: true,
        isBare: true,
        paused: true,
        selectedAgentBackend: true,
        effectiveAgentBackend: true,
        defaultModel: true,
        defaultThinkingLevel: true,
        reviewModel: true,
        reviewThinkingLevel: true,
        mergePolicy: true,
        includeAllIssueAuthors: true,
        waitForReadyForReviewChecks: true,
        issuesReconciledAt: true,
        blockingUnfinishedWorkItemCount: true,
      },
      repositoryCredentials: {
        repositoryId: true,
        configured: true,
        githubTokenSecretName: true,
        githubTokenCreationUrl: true,
      },
    })
    return result.repositories.map((repository) => {
      const credential = result.repositoryCredentials.find(
        ({ repositoryId }) => repositoryId === repository.id,
      )
      if (credential === undefined) {
        throw new Error(`Missing credential status for ${repository.id}`)
      }
      return { ...repository, credential }
    })
  },
}
