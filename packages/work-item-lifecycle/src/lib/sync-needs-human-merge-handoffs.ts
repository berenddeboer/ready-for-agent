import { Effect } from "effect"
import { DbService } from "@ready-for-agent/db-service"
import { GitHubService } from "@ready-for-agent/github-service"
import { WorkItemLifecycle } from "./work-item-lifecycle.js"
import { workItemBranchName } from "./worktree-names.js"

/**
 * After Issue reconciliation, resume merge-related Needs Human handoffs when
 * the Work Item PR was merged (local cleanup) or closed unmerged (Abandon).
 * GitHub lookup failures are skipped so Refresh still succeeds.
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
      if (workItem.state !== "needs_human") {
        continue
      }
      if (workItem.githubPullRequestNumber === null) {
        continue
      }
      const latest = workItem.stepRuns.at(-1)
      if (
        latest === undefined ||
        (latest.step !== "decide_pr_merge" && latest.step !== "merge_pr") ||
        latest.status !== "succeeded"
      ) {
        continue
      }

      const headRefName = workItemBranchName({
        githubOwner: repository.githubOwner,
        githubRepo: repository.githubRepo,
        githubIssueNumber: workItem.githubIssueNumber,
        workItemId: workItem.id,
      })

      const status = yield* github
        .getPullRequestLifecycleStatus(
          {
            owner: repository.githubOwner,
            name: repository.githubRepo,
          },
          headRefName,
        )
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              "Skipping Needs Human merge handoff: PR lifecycle lookup failed",
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
              Effect.logWarning(
                "Failed to resume Needs Human after human merge",
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
        continue
      }

      if (status._tag === "closed") {
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
