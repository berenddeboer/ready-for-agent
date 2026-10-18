import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Duration, Effect, Layer, ManagedRuntime } from "effect"
import {
  AzureDevOpsService,
  type AzureDevOpsServiceShape,
} from "@ready-for-agent/azure-devops-service"
import { DatabaseTest } from "@ready-for-agent/db/test"
import {
  DbService,
  DbServiceLive,
  RepositoryNotFoundError,
} from "@ready-for-agent/db-service"
import {
  GitHubService,
  type GitHubServiceShape,
} from "@ready-for-agent/github-service"
import {
  GitLabService,
  type GitLabServiceShape,
} from "@ready-for-agent/gitlab-service"
import { IssueReconciler } from "@ready-for-agent/issue-reconciler"
import { disabledKeymaxxerLayer } from "@ready-for-agent/keymaxxer-service"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import { WorkItemLifecycle } from "@ready-for-agent/work-item-lifecycle"
import { JobWorkerLive } from "../src/server/job-worker.js"

describe("automatic repair worker context", () => {
  it.live(
    "a refresh inside the built worker considers automatic CI repair",
    () =>
      Effect.gen(function* () {
        const applicationServer = readFileSync(
          new URL("../src/server/application.server.ts", import.meta.url),
          "utf8",
        )
        const workerLayer = applicationServer.slice(
          applicationServer.indexOf("const workerLayer = JobWorkerLive.pipe("),
          applicationServer.indexOf("const loggingLayer"),
        )
        expect(workerLayer).not.toContain("repairLayer")
        expect(workerLayer).not.toContain("RepositoryCiRepair")

        const seen = yield* Deferred.make<string>()
        const database = DbServiceLive.pipe(Layer.provideMerge(DatabaseTest))
        const queue = SqliteQueueServiceLive.pipe(Layer.provideMerge(database))
        // The lifecycle claim loop reads maxDurations before the first claim.
        // A thinner stub kills that fiber and leaves the refresh job pending.
        const lifecycle = Layer.succeed(WorkItemLifecycle, {
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
          recoverOrphanedStepRuns: Effect.succeed(0),
          interruptRunningStepRunsFromPriorWorker: Effect.succeed(0),
          releaseWaitingForCiRepair: () => Effect.succeed(0),
          unfinishedCiRepairWorkItem: () => Effect.die("unused"),
          startCiRepair: () => Effect.die("unused"),
          considerAutomaticCiRepair: (repositoryId: string) =>
            Deferred.succeed(seen, repositoryId).pipe(Effect.as(null)),
        } as never)
        const reconciler = Layer.succeed(IssueReconciler, {
          reconcile: (repository) =>
            Effect.fail(
              new RepositoryNotFoundError({ repositoryId: repository.id }),
            ),
        })
        const seed = Layer.effectDiscard(
          Effect.gen(function* () {
            const db = yield* DbService
            yield* db.addRepository({
              forge: "github",
              forgeHost: "github.com",
              projectPath: "acme/widgets",
              localPath: "/repos/acme/widgets-worker.git",
              isBare: true,
            })
          }),
        ).pipe(Layer.provideMerge(database))
        const worker = JobWorkerLive.pipe(
          Layer.provideMerge(queue),
          Layer.provideMerge(seed),
          Layer.provideMerge(reconciler),
          Layer.provideMerge(lifecycle),
          Layer.provideMerge(disabledKeymaxxerLayer),
        )
        // Credential checks and CI observation name these services. This
        // GitHub repository, with Keymaxxer disabled and no CI selection,
        // never calls them. Empty shapes die if a method is reached.
        const forges = Layer.mergeAll(
          Layer.succeed(GitHubService, {} as GitHubServiceShape),
          Layer.succeed(GitLabService, {} as GitLabServiceShape),
          Layer.succeed(AzureDevOpsService, {} as AzureDevOpsServiceShape),
        )
        const runtime = ManagedRuntime.make(
          Layer.mergeAll(worker, database).pipe(Layer.provide(forges)),
        )
        yield* Effect.gen(function* () {
          const repositoryId = yield* Effect.promise(() =>
            runtime.runPromise(
              Effect.gen(function* () {
                const db = yield* DbService
                const repositories = yield* db.listRepositories
                return repositories[0]?.id
              }),
            ),
          )
          const observed = yield* Deferred.await(seen).pipe(
            Effect.timeout("8 seconds"),
          )
          expect(observed).toBe(repositoryId)
        }).pipe(Effect.ensuring(Effect.promise(() => runtime.dispose())))
      }),
  )
})
