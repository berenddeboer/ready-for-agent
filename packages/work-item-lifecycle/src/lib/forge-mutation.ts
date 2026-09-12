import { Effect } from "effect"
import {
  AzureDevOpsService,
  type AzureDevOpsServiceError,
} from "@ready-for-agent/azure-devops-service"
import {
  type ForgeRepository,
  type ResolvedForgePullRequestMutations,
  azureDevOpsPullRequestMutations,
  githubPullRequestMutations,
  gitlabPullRequestMutations,
} from "@ready-for-agent/forge-contract"
import {
  GitHubService,
  type GitHubServiceError,
} from "@ready-for-agent/github-service"
import {
  GitLabService,
  type GitLabServiceError,
} from "@ready-for-agent/gitlab-service"
import type { Forge } from "@ready-for-agent/lifecycle-model"

export type ForgeMutationError =
  | GitHubServiceError
  | GitLabServiceError
  | AzureDevOpsServiceError

export type ResolvedLifecycleForgePullRequestMutations =
  ResolvedForgePullRequestMutations<ForgeMutationError>

export const toForgeRepository = (repository: {
  readonly forge: string
  readonly forgeHost: string
  readonly projectPath: string
}): ForgeRepository => ({
  forge: repository.forge,
  forgeHost: repository.forgeHost,
  projectPath: repository.projectPath,
})

/**
 * Resolve PR mutations from the Repository Forge. Only the matching
 * provider service is required at runtime. Cleanup stays combined on
 * GitHub and sequential on GitLab/Azure DevOps. Azure Issue association
 * and post-merge Boards completion stay Azure-only.
 */
export const forgePullRequestMutations = (repository: {
  readonly forge: Forge
}): Effect.Effect<
  ResolvedLifecycleForgePullRequestMutations,
  never,
  GitHubService | GitLabService | AzureDevOpsService
> => {
  switch (repository.forge) {
    case "github":
      return Effect.gen(function* () {
        const github = yield* GitHubService
        return githubPullRequestMutations(github)
      })
    case "gitlab":
      return Effect.gen(function* () {
        const gitlab = yield* GitLabService
        return gitlabPullRequestMutations(gitlab)
      })
    case "azure-devops":
      return Effect.gen(function* () {
        const azureDevOps = yield* AzureDevOpsService
        return azureDevOpsPullRequestMutations(azureDevOps)
      })
    default: {
      const _exhaustive: never = repository.forge
      return _exhaustive
    }
  }
}
