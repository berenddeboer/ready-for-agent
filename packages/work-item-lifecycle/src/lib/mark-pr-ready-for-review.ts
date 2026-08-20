import { Effect, Schema } from "effect"
import { AzureDevOpsService } from "@ready-for-agent/azure-devops-service"
import { DbService } from "@ready-for-agent/db-service"
import { GitHubService } from "@ready-for-agent/github-service"
import { GitLabService } from "@ready-for-agent/gitlab-service"
import type { LifecycleStepContext } from "./lifecycle-steps.js"
import { workItemBranchName } from "./worktree-names.js"

export class MarkPrReadyForReviewContextError extends Schema.TaggedErrorClass<MarkPrReadyForReviewContextError>()(
  "MarkPrReadyForReviewContextError",
  {
    message: Schema.String,
  },
) {}

/**
 * Production Mark PR Ready for Review Lifecycle Step.
 * After status checks are green, converts the draft PR/MR on the Work Item
 * branch to ready for review (GitHub GraphQL, GitLab draft flag, or Azure
 * DevOps `isDraft` field).
 */
export const markPrReadyForReview = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    if (context.worktreePath === null || context.worktreePath.trim() === "") {
      return yield* new MarkPrReadyForReviewContextError({
        message: "Mark PR ready for review requires a persisted worktree path",
      })
    }
    const db = yield* DbService
    const repositories = yield* db.listRepositories
    const repository = repositories.find(
      ({ id }) => id === context.repositoryId,
    )
    if (repository === undefined) {
      return yield* new MarkPrReadyForReviewContextError({
        message: `Repository ${context.repositoryId} was not found`,
      })
    }
    const branch = workItemBranchName({
      projectPath: repository.projectPath,
      issueNumber: context.issueNumber,
      workItemId: context.workItemId,
    })
    switch (repository.forge) {
      case "gitlab": {
        const gitlab = yield* GitLabService
        yield* gitlab.markPullRequestReadyForReview(repository, branch)
        return
      }
      case "azure-devops": {
        const azureDevOps = yield* AzureDevOpsService
        yield* azureDevOps.markPullRequestReadyForReview(repository, branch)
        return
      }
      case "github": {
        const github = yield* GitHubService
        yield* github.markPullRequestReadyForReview(repository, branch)
        return
      }
      default: {
        const _exhaustive: never = repository.forge
        return _exhaustive
      }
    }
  })
