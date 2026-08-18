import { Duration, Effect, Layer } from "effect"
import {
  makeRepositoryRecord,
  stubDbServiceLayer,
} from "@ready-for-agent/db-service/test"
import { IssueReconciler } from "@ready-for-agent/issue-reconciler"
import {
  WorkItemLifecycle,
  stubGitHubServiceLayer,
  stubGitLabServiceLayer,
} from "@ready-for-agent/work-item-lifecycle"
import { refreshLoadedRepository } from "../src/server/repository-refresh.js"
import { describe, expect, it } from "bun:test"

const unused = () => Effect.die("not used")

describe("refreshLoadedRepository", () => {
  it("stops competing Work Items before merge-handoff sync and blocker release", () =>
    Effect.gen(function* () {
      const repository = makeRepositoryRecord()
      const calls: string[] = []
      const observations = [
        {
          issueNumber: 42,
          identities: [{ repository: "acme/widgets", number: 1049 }],
        },
      ]

      yield* refreshLoadedRepository({
        repository,
        githubOperationOrigin: "operator",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            stubDbServiceLayer({
              listRepositories: Effect.succeed([repository]),
              notifyIssuesChanged: (repositoryId) =>
                Effect.sync(() => {
                  calls.push(`notify:${repositoryId}`)
                }),
            }),
            stubGitHubServiceLayer(),
            stubGitLabServiceLayer(),
            Layer.succeed(IssueReconciler, {
              reconcile: () =>
                Effect.sync(() => {
                  calls.push("reconcile")
                  return {
                    fetched: 1,
                    inserted: 0,
                    updated: 0,
                    deleted: 1,
                    unchanged: 0,
                    competingObservations: observations,
                  }
                }),
            }),
            Layer.succeed(WorkItemLifecycle, {
              maxDurations: {
                create_worktree: Duration.minutes(5),
                install_dependencies: Duration.minutes(15),
                implement: Duration.hours(2),
                assess_changes: Duration.minutes(5),
                pre_commit: Duration.hours(2),
                review: Duration.hours(1),
                commit: Duration.minutes(5),
                create_pr: Duration.minutes(10),
                watch_pr_status_checks: Duration.minutes(5),
                resolve_pr_merge_conflict: Duration.hours(2),
                investigate_pr_status_checks: Duration.hours(2),
                mark_pr_ready_for_review: Duration.minutes(5),
                decide_pr_merge: Duration.minutes(15),
                merge_pr: Duration.minutes(5),
                close_issue: Duration.minutes(5),
                local_cleanup: Duration.minutes(5),
              },
              implementNow: unused,
              implementWith: unused,
              implementLocally: unused,
              implementAllWithAutoMerge: unused,
              queue: unused,
              recoverOrphanedStepRuns: Effect.succeed(0),
              interruptRunningStepRunsFromPriorWorker: Effect.succeed(0),
              runStep: unused,
              wakePostponedStep: unused,
              retry: unused,
              pause: unused,
              interrupt: unused,
              start: unused,
              abandon: unused,
              reset: unused,
              getWorkItem: unused,
              listWorkItemsForIssue: unused,
              listWorkItemsForRepository: () => Effect.succeed([]),
              listCompletedWorkItems: unused,
              ownsSessionId: () => Effect.succeed(false),
              findWorkItemBySessionId: unused,
              countCommittedPullRequests: unused,
              continueAfterHumanPrOutcome: unused,
              stopForCompetingIssueClosingPullRequests: (
                repositoryId,
                received,
              ) =>
                Effect.sync(() => {
                  calls.push(
                    `stop:${repositoryId}:${received[0]?.identities[0]?.number}`,
                  )
                  return 1
                }),
              admitWaitingWorkItems: Effect.succeed(0),
              releaseWaitingForBlockers: (repositoryId) =>
                Effect.sync(() => {
                  calls.push(`release:${repositoryId}`)
                  return 0
                }),
            }),
          ),
        ),
      )

      expect(calls).toEqual([
        "reconcile",
        `stop:${repository.id}:1049`,
        `release:${repository.id}`,
        `notify:${repository.id}`,
      ])
    }).pipe(Effect.runPromise))
})
