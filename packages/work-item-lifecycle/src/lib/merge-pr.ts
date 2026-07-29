import { Effect, Schema } from "effect"
import { DbService } from "@ready-for-agent/db-service"
import { GitHubService } from "@ready-for-agent/github-service"
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
 * After Decide PR Merge chooses clanker merge, squash-merges the open PR on the
 * Work Item branch via the GitHub GraphQL API (token-backed, no `gh`).
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
    if (repository.forge === "gitlab") {
      return yield* new MergePrContextError({
        message:
          "GitLab Merge PR requires GitLab PR lifecycle support; refusing to query GitHub for a GitLab Repository",
      })
    }
    const branch = workItemBranchName({
      projectPath: repository.projectPath,
      issueNumber: context.issueNumber,
      workItemId: context.workItemId,
    })
    const github = yield* GitHubService
    return yield* github.mergePullRequest(repository, branch)
  })
