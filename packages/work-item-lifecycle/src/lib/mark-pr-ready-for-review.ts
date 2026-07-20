import { Effect, Schema } from "effect"
import { DbService } from "@ready-for-agent/db-service"
import { GitHubService } from "@ready-for-agent/github-service"
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
 * After status checks are green, converts the draft PR on the Work Item branch
 * to ready for review via the GitHub GraphQL API (token-backed, no `gh`).
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
      githubOwner: repository.githubOwner,
      githubRepo: repository.githubRepo,
      githubIssueNumber: context.githubIssueNumber,
      workItemId: context.workItemId,
    })
    const github = yield* GitHubService
    yield* github.markPullRequestReadyForReview(
      { owner: repository.githubOwner, name: repository.githubRepo },
      branch,
    )
  })
