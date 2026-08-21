import { Effect } from "effect"
import { AzureDevOpsService } from "@ready-for-agent/azure-devops-service"
import { DbService } from "@ready-for-agent/db-service"
import {
  GitHubService,
  type GitHubThrottledError,
  type PullRequestCheckStatus,
  type PullRequestLifecycleStatus,
  isGitHubThrottledError,
} from "@ready-for-agent/github-service"
import { GitLabService } from "@ready-for-agent/gitlab-service"
import { WorkItemLifecycle } from "./work-item-lifecycle.js"
import { workItemBranchName } from "./worktree-names.js"

const skipNonThrottleLookupFailure = <A>(
  lookup: Effect.Effect<A, unknown>,
  input: {
    readonly message: string
    readonly repositoryId: string
    readonly workItemId: string
  },
): Effect.Effect<A | null, GitHubThrottledError> =>
  lookup.pipe(
    Effect.catch((error) =>
      isGitHubThrottledError(error)
        ? Effect.fail(error)
        : Effect.logWarning(input.message, {
            workItemId: input.workItemId,
            repositoryId: input.repositoryId,
            error: String(error),
          }).pipe(Effect.as(null)),
    ),
  )

/**
 * After Issue reconciliation, advance Work Items whose Work Item PR was merged
 * (any unfinished operational step or Needs Human with a Work Item PR) to local
 * cleanup, Abandon merge-related Needs Human when the PR was closed unmerged,
 * and for open-PR Needs Human handoffs observe mergeability (ADR 0046):
 * Decide/Merge Needs Human + conflicting → Resolve PR Merge Conflict;
 * Resolve Needs Human + no longer conflicting → Watch PR Status Checks.
 * Non-throttle Forge lookup failures are skipped so Refresh still succeeds;
 * explicit GitHub throttles propagate to durably postpone the Refresh Job.
 */
export const syncNeedsHumanMergeHandoffs = (repositoryId: string) =>
  Effect.gen(function* () {
    const lifecycle = yield* WorkItemLifecycle
    const db = yield* DbService
    const repositories = yield* db.listRepositories
    const repository = repositories.find(({ id }) => id === repositoryId)
    if (repository === undefined) {
      return 0
    }
    const github = yield* GitHubService
    const gitlab = yield* GitLabService
    const azureDevOps = yield* AzureDevOpsService

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
      const isResolveNeedsHuman =
        workItem.state === "needs_human" &&
        latest !== undefined &&
        latest.step === "resolve_pr_merge_conflict" &&
        latest.status === "succeeded"
      const isClosedUnmergedEligible = isMergeNeedsHuman || isResolveNeedsHuman

      const headRefName = workItemBranchName({
        projectPath: repository.projectPath,
        issueNumber: workItem.issueNumber,
        workItemId: workItem.id,
      })

      const lifecycleLookup: Effect.Effect<
        PullRequestLifecycleStatus,
        unknown
      > = ((): Effect.Effect<PullRequestLifecycleStatus, unknown> => {
        switch (repository.forge) {
          case "gitlab":
            return gitlab.getPullRequestLifecycleStatus(repository, headRefName)
          case "azure-devops":
            return azureDevOps.getPullRequestLifecycleStatus(
              repository,
              headRefName,
            )
          case "github":
            return github.getPullRequestLifecycleStatus(repository, headRefName)
          default: {
            const _exhaustive: never = repository.forge
            return _exhaustive
          }
        }
      })()

      const status = yield* skipNonThrottleLookupFailure(lifecycleLookup, {
        message:
          "Skipping Work Item PR merge outcome: PR lifecycle lookup failed",
        workItemId: workItem.id,
        repositoryId,
      })

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

      // Closed-unmerged: Decide/Merge/Resolve Needs Human only (ADR 0039 / 0046).
      if (status._tag === "closed" && isClosedUnmergedEligible) {
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
        continue
      }

      // Open PR: mergeability for Decide/Merge or Resolve Needs Human (ADR 0046).
      // Reuse Watch's check-status path as the mergeability source of truth.
      if (
        status._tag === "open" &&
        (isMergeNeedsHuman || isResolveNeedsHuman)
      ) {
        const checkStatusLookup: Effect.Effect<
          PullRequestCheckStatus,
          unknown
        > = ((): Effect.Effect<PullRequestCheckStatus, unknown> => {
          switch (repository.forge) {
            case "gitlab":
              return gitlab.getPullRequestCheckStatus(repository, headRefName)
            case "azure-devops":
              return azureDevOps.getPullRequestCheckStatus(
                repository,
                headRefName,
              )
            case "github":
              return github.getPullRequestCheckStatus(repository, headRefName)
            default: {
              const _exhaustive: never = repository.forge
              return _exhaustive
            }
          }
        })()

        const checkStatus = yield* skipNonThrottleLookupFailure(
          checkStatusLookup,
          {
            message:
              "Skipping Needs Human mergeability: PR check status lookup failed",
            workItemId: workItem.id,
            repositoryId,
          },
        )

        if (checkStatus === null) {
          continue
        }

        // Lifecycle said open, but check-status can still see closed (TOCTOU).
        // Do not trust mergeability alone: Watch prioritizes closed first, and a
        // false merge_conflict_cleared advance leaves Resolve NH stuck as
        // watch_pr_status_checks Needs Human (not closed-unmerged eligible).
        // Skip so the next Refresh re-reads lifecycle and abandons/merges.
        if (checkStatus._tag === "closed") {
          continue
        }

        // Unknown mergeability is a no-op; still-conflicting Resolve stays parked.
        if (checkStatus.mergeability === "unknown") {
          continue
        }

        if (isMergeNeedsHuman && checkStatus.mergeability === "conflicting") {
          const didAdvance = yield* lifecycle
            .continueAfterHumanPrOutcome(workItem.id, "merge_conflict")
            .pipe(
              Effect.as(true),
              Effect.catch((error) =>
                Effect.logWarning(
                  "Failed to advance Decide/Merge Needs Human after observed merge conflict",
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

        if (isResolveNeedsHuman && checkStatus.mergeability === "mergeable") {
          const didAdvance = yield* lifecycle
            .continueAfterHumanPrOutcome(workItem.id, "merge_conflict_cleared")
            .pipe(
              Effect.as(true),
              Effect.catch((error) =>
                Effect.logWarning(
                  "Failed to advance Resolve Needs Human after merge conflict cleared",
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
    }

    return advanced
  })
