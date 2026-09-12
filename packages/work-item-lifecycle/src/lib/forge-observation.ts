import type { Effect } from "effect"
import {
  AzureDevOpsService,
  type AzureDevOpsServiceError,
} from "@ready-for-agent/azure-devops-service"
import type { ForgeObservation } from "@ready-for-agent/forge-contract"
import {
  GitHubService,
  type GitHubServiceError,
} from "@ready-for-agent/github-service"
import {
  GitLabService,
  type GitLabServiceError,
} from "@ready-for-agent/gitlab-service"
import type { Forge } from "@ready-for-agent/lifecycle-model"

export type ForgeObservationError =
  | GitHubServiceError
  | GitLabServiceError
  | AzureDevOpsServiceError

export type ResolvedForgeObservation = ForgeObservation<ForgeObservationError>

/**
 * Select the PR/CI observation view for a Repository's existing Forge.
 * PR mutations resolve through the sibling `forge-mutation` module.
 */
export const resolveForgeObservation = (
  forge: Forge,
  providers: {
    readonly github: ResolvedForgeObservation
    readonly gitlab: ResolvedForgeObservation
    readonly azureDevOps: ResolvedForgeObservation
  },
): ResolvedForgeObservation => {
  switch (forge) {
    case "github":
      return providers.github
    case "gitlab":
      return providers.gitlab
    case "azure-devops":
      return providers.azureDevOps
    default: {
      const _exhaustive: never = forge
      return _exhaustive
    }
  }
}

/**
 * Resolve PR/CI observations from the Repository Forge. Only the matching
 * provider service is required at runtime.
 */
export const forgeObservation = (repository: {
  readonly forge: Forge
}): Effect.Effect<
  ResolvedForgeObservation,
  never,
  GitHubService | GitLabService | AzureDevOpsService
> => {
  switch (repository.forge) {
    case "github":
      return GitHubService
    case "gitlab":
      return GitLabService
    case "azure-devops":
      return AzureDevOpsService
    default: {
      const _exhaustive: never = repository.forge
      return _exhaustive
    }
  }
}
