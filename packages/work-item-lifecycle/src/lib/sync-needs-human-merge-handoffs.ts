import { Effect } from "effect"
import { DbService } from "@ready-for-agent/db-service"
import { GitHubService } from "@ready-for-agent/github-service"
import { WorkItemLifecycle } from "./work-item-lifecycle.js"
import { workItemBranchName } from "./worktree-names.js"

/**
 * After Issue reconciliation, advance Work Items whose Work Item PR was merged
 * (any unfinished operational step or Needs Human with a Work Item PR) to local
 * cleanup, and Abandon merge-related Needs Human when the PR was closed
 * unmerged. GitHub lookup failures are skipped so Refresh still succeeds.
 */
export const syncNeedsHumanMergeHandoffs = (repositoryId: string) =>
  Effect.gen(function* () {
    const lifecycle = yield* WorkItemLifecycle
    const github = yield* GitHubService
    const db = yield* DbService
    const repositories = yield* db.listRepositories
    const repository = repositories.find(({ id }) => id === repositoryId)
    if (repository === undefined) {
      return 0
    }

    const workItems = yield* lifecycle.listWorkItemsForRepository(repositoryId)
    let advanced = 0

    for (const workItem of workItems) {
      if (workItem.pullRequestNumber === null) {
        continue
      }
      // Already past merge outcome handling.
      if (
        workItem.state === "complete" ||
        workItem.state === "failed" ||
        workItem.state === "abandoned" ||
        workItem.state === "local_cleanup"
      ) {
        continue
      }

      const latest = workItem.stepRuns.at(-1)
      const isMergeNeedsHuman =
        workItem.state === "needs_human" &&
        latest !== undefined &&
        (latest.step === "decide_pr_merge" || latest.step === "merge_pr") &&
        latest.status === "succeeded"

      const headRefName = workItemBranchName({
        projectPath: repository.projectPath,
        issueNumber: workItem.issueNumber,
        workItemId: workItem.id,
      })

      const status = yield* github
        .getPullRequestLifecycleStatus(repository, headRefName)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              "Skipping Work Item PR merge outcome: PR lifecycle lookup failed",
              {
                workItemId: workItem.id,
                repositoryId,
                error: String(error),
              },
            ).pipe(Effect.as(null)),
          ),
        )

      if (status === null) {
        continue
      }

      if (status._tag === "merged") {
        const didAdvance = yield* lifecycle
          .continueAfterHumanPrOutcome(workItem.id, "merged")
          .pipe(
            Effect.as(true),
            Effect.catch((error) =>
              Effect.logWarning("Failed to advance Work Item after merged PR", {
                workItemId: workItem.id,
                error: String(error),
              }).pipe(Effect.as(false)),
            ),
          )
        if (didAdvance) {
          advanced += 1
        }
        continue
      }

      // Closed-unmerged outside merge-related Needs Human is out of scope.
      if (status._tag === "closed" && isMergeNeedsHuman) {
        const didAdvance = yield* lifecycle
          .continueAfterHumanPrOutcome(workItem.id, "closed_unmerged")
          .pipe(
            Effect.as(true),
            Effect.catch((error) =>
              Effect.logWarning(
                "Failed to abandon Needs Human after closed unmerged PR",
                {
                  workItemId: workItem.id,
                  error: String(error),
                },
              ).pipe(Effect.as(false)),
            ),
          )
        if (didAdvance) {
          advanced += 1
        }
      }
    }

    return advanced
  })
