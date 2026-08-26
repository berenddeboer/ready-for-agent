import { Effect, Schema } from "effect"
import { AzureDevOpsService } from "@ready-for-agent/azure-devops-service"
import { DbService } from "@ready-for-agent/db-service"
import { GitHubService } from "@ready-for-agent/github-service"
import { GitLabService } from "@ready-for-agent/gitlab-service"
import type { LifecycleStepContext } from "./lifecycle-steps.js"
import { resolveEffectiveMergePolicy } from "./merge-policy.js"
import { workItemBranchName } from "./worktree-names.js"

export class MergePrContextError extends Schema.TaggedErrorClass<MergePrContextError>()(
  "MergePrContextError",
  {
    message: Schema.String,
  },
) {}

const AZURE_BOARDS_MERGE_COMPLETION_SUMMARY =
  "Completed after the pull request merged."

const azureBoardsMergeCompletionSummary = (
  context: LifecycleStepContext,
): string => {
  const persisted = context.completionSummary?.trim()
  if (persisted !== undefined && persisted !== "") {
    return persisted
  }
  return AZURE_BOARDS_MERGE_COMPLETION_SUMMARY
}

/**
 * Production Merge PR Lifecycle Step.
 * After Decide PR Merge chooses clanker merge, merges the open PR/MR on the
 * Work Item branch via the Forge API (token-backed; expected head SHA).
 * GitHub squash-merges; GitLab and Azure DevOps defer merge method to
 * project/repository settings. On Azure DevOps, a successful merge then
 * completes the Boards Issue if it is still open (harness-owned backup for
 * `transitionWorkItems`).
 */
export const mergePr = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    if (context.worktreePath === null || context.worktreePath.trim() === "") {
      return yield* new MergePrContextError({
        message: "Merge PR requires a persisted worktree path",
      })
    }
    const db = yield* DbService
    const repositories = yield* db.listRepositories
    const repository = repositories.find(
      ({ id }) => id === context.repositoryId,
    )
    if (repository === undefined) {
      return yield* new MergePrContextError({
        message: `Repository ${context.repositoryId} was not found`,
      })
    }
    const branch = workItemBranchName({
      projectPath: repository.projectPath,
      issueNumber: context.issueNumber,
      workItemId: context.workItemId,
    })
    const effectivePolicy = resolveEffectiveMergePolicy({
      repositoryMergePolicy: repository.mergePolicy,
      workItemMergeMode: context.mergeMode,
      workItemAutoMergeOverride: context.autoMergeOverride,
    })
    const options =
      effectivePolicy === "always" ? { acceptNoChecks: true } : undefined
    switch (repository.forge) {
      case "gitlab": {
        const gitlab = yield* GitLabService
        return yield* gitlab.mergePullRequest(repository, branch, options)
      }
      case "azure-devops": {
        const azureDevOps = yield* AzureDevOpsService
        const result = yield* azureDevOps.mergePullRequest(
          repository,
          branch,
          options,
        )
        if (result._tag === "merged") {
          yield* azureDevOps.ensureIssueCompletedWithSummary(
            repository,
            context.issueNumber,
            context.workItemId,
            azureBoardsMergeCompletionSummary(context),
          )
        }
        return result
      }
      case "github": {
        const github = yield* GitHubService
        return yield* github.mergePullRequest(repository, branch, options)
      }
      default: {
        const _exhaustive: never = repository.forge
        return _exhaustive
      }
    }
  })
