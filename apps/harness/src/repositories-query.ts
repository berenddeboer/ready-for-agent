/**
 * Shared Configured Repositories list query for root chrome, Jobs filters,
 * board routes, and live membership followers.
 *
 * Lives outside any single route module so sticky chrome can gate on membership
 * without importing the home route.
 */

import { type Forge, isForge } from "@ready-for-agent/lifecycle-model"
import { createHarnessGraphqlClient } from "./harness-graphql.js"

const graphql = createHarnessGraphqlClient({ batch: true })

type RepositoryCredential = {
  repositoryId: string
  configured: boolean
  githubTokenSecretName: string
  githubTokenCreationUrl: string
}

export type { Forge }

const FORGE_DISPLAY_NAMES: Record<Forge, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  "azure-devops": "Azure DevOps",
}

export const forgeDisplayName = (forge: Forge): string =>
  FORGE_DISPLAY_NAMES[forge]

export const ciGateStatusLabel = (status: RepositoryCiGateStatus): string => {
  switch (status) {
    case "DISABLED":
      return "Disabled"
    case "OPEN":
      return "Open"
    case "CLOSED":
      return "Closed"
    case "DEGRADED":
      return "Degraded"
  }
}

export const decodeForge = (value: unknown): Forge => {
  if (isForge(value)) {
    return value
  }
  throw new Error(`Unsupported Forge: ${String(value)}`)
}

type CiGateDefinition = {
  identity: string
  displayLabel: string
  kind: string
  diagnosticMetadata: string | null
}

export type RepositoryCiGateStatus = "DISABLED" | "OPEN" | "CLOSED" | "DEGRADED"

type RepositoryCiGate = {
  enabled: boolean
  status: RepositoryCiGateStatus
  observedAt: string | null
  defaultBranch: string | null
  diagnostic: string | null
  definitions: readonly {
    identity: string
    displayLabel: string
    kind: string
    diagnosticMetadata: string | null
    failureLatched: boolean
    diagnostic: string | null
    latestRun: {
      runIdentity: string
      htmlUrl: string | null
      headSha: string | null
      headRef: string | null
      event: string | null
      rawStatus: string | null
      rawConclusion: string | null
      createdAt: string | null
      updatedAt: string | null
    } | null
  }[]
  activeIncident: {
    id: string
    status: "OPEN" | "RESOLVED"
    openedAt: string
    resolvedAt: string | null
    recoveryReason: string | null
    summary: string
    failedDefinitions: readonly CiGateDefinition[]
  } | null
  latestResolvedIncident: {
    id: string
    status: "OPEN" | "RESOLVED"
    openedAt: string
    resolvedAt: string | null
    recoveryReason: string | null
    summary: string
    failedDefinitions: readonly CiGateDefinition[]
  } | null
}

export type Repository = {
  id: string
  forge: Forge
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
  selectedCiGateDefinitions: readonly CiGateDefinition[]
  ciGate: RepositoryCiGate
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
        selectedCiGateDefinitions: {
          identity: true,
          displayLabel: true,
          kind: true,
          diagnosticMetadata: true,
        },
        ciGate: {
          enabled: true,
          status: true,
          observedAt: true,
          defaultBranch: true,
          diagnostic: true,
          definitions: {
            identity: true,
            displayLabel: true,
            kind: true,
            diagnosticMetadata: true,
            failureLatched: true,
            diagnostic: true,
            latestRun: {
              runIdentity: true,
              htmlUrl: true,
              headSha: true,
              headRef: true,
              event: true,
              rawStatus: true,
              rawConclusion: true,
              createdAt: true,
              updatedAt: true,
            },
          },
          activeIncident: {
            id: true,
            status: true,
            openedAt: true,
            resolvedAt: true,
            recoveryReason: true,
            summary: true,
            failedDefinitions: {
              identity: true,
              displayLabel: true,
              kind: true,
              diagnosticMetadata: true,
            },
          },
          latestResolvedIncident: {
            id: true,
            status: true,
            openedAt: true,
            resolvedAt: true,
            recoveryReason: true,
            summary: true,
            failedDefinitions: {
              identity: true,
              displayLabel: true,
              kind: true,
              diagnosticMetadata: true,
            },
          },
        },
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
      return { ...repository, forge: decodeForge(repository.forge), credential }
    })
  },
}
