import { Effect, Schema } from "effect"
import { DbService } from "@ready-for-agent/db-service"
import { GitHubService } from "@ready-for-agent/github-service"
import { GitLabService } from "@ready-for-agent/gitlab-service"
import type { LifecycleStepContext } from "./lifecycle-steps.js"
import { workItemBranchName } from "./worktree-names.js"

export class MergePrContextError extends Schema.TaggedErrorClass<MergePrContextError>()(
  "MergePrContextError",
  {
    message: Schema.String,
  },
) {}

/**
 * Production Merge PR Lifecycle Step.
 * After Decide PR Merge chooses clanker merge, merges the open PR/MR on the
 * Work Item branch via the Forge API (token-backed; expected head SHA).
 * GitHub squash-merges; GitLab defers merge method to project settings.
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
    if (repository.forge === "gitlab") {
      const gitlab = yield* GitLabService
      return yield* gitlab.mergePullRequest(repository, branch)
    }
    const github = yield* GitHubService
    return yield* github.mergePullRequest(repository, branch)
  })
