/**
 * Shared Configured Repositories list query for root chrome, Jobs filters,
 * board routes, and live membership followers.
 *
 * Lives outside any single route module so sticky chrome can gate on membership
 * without importing the home route.
 */

import { type Forge, isForge } from "@ready-for-agent/lifecycle-model"
import type { RepositoryCiGateStatus } from "./ci-gate-status-label.js"
import type {
  CiGateStoryIncident,
  CiGateStoryInput,
} from "./ci-gate-status-story.js"
import { createHarnessGraphqlClient } from "./harness-graphql.js"

export { ciGateStatusLabel } from "./ci-gate-status-label.js"

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

type RepositoryCiGate = CiGateStoryInput & {
  enabled: boolean
  status: RepositoryCiGateStatus
  definitions: readonly (CiGateStoryInput["definitions"][number] & {
    kind: string
    diagnosticMetadata: string | null
  })[]
  activeIncident: CiGateStoryInput["activeIncident"]
  incidentHistory: readonly CiGateStoryIncident[]
  activeRepair: CiGateStoryInput["activeRepair"]
  canStartCiRepair: boolean
}

type LinearTeamWorkflowSelection = {
  teamId: string
  teamKey: string
  teamName: string
  inProgressStateId: string
  inProgressStateName: string
  doneStateId: string
  doneStateName: string
}

export type Repository = {
  id: string
  forge: Forge
  issueTracker: string
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
  automaticCiRepair: boolean
  selectedCiGateDefinitions: readonly CiGateDefinition[]
  ciGate: RepositoryCiGate
  linearProjectId: string | null
  linearProjectName: string | null
  linearWorkflowStatuses: readonly LinearTeamWorkflowSelection[]
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
        issueTracker: true,
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
        automaticCiRepair: true,
        linearProjectId: true,
        linearProjectName: true,
        linearWorkflowStatuses: {
          teamId: true,
          teamKey: true,
          teamName: true,
          inProgressStateId: true,
          inProgressStateName: true,
          doneStateId: true,
          doneStateName: true,
        },
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
              orderKey: true,
              earlyJobFailure: true,
            },
            failingRun: {
              runIdentity: true,
              htmlUrl: true,
              orderKey: true,
              detectedAt: true,
            },
          },
          activeIncident: {
            id: true,
            openedAt: true,
          },
          incidentHistory: {
            id: true,
            openedAt: true,
            resolvedAt: true,
            summary: true,
            failedRuns: {
              definitionIdentity: true,
              displayLabel: true,
              runIdentity: true,
              htmlUrl: true,
            },
          },
          activeRepair: {
            workItemId: true,
            stateLabel: true,
            statusLabel: true,
            htmlUrl: true,
          },
          canStartCiRepair: true,
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
