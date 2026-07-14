import { Cause, Effect, Layer, Option, Result } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import {
  EnqueueError,
  type JobId,
  QueueService,
  type QueueServiceShape,
} from "@ready-for-agent/queue-service"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
  IssueBlockedError,
  IssueNotFoundError,
  IssueNotOpenError,
  type LifecycleStepContext,
  LifecycleSteps,
  type LifecycleStepsShape,
  NonTransactionalQueueError,
  ParentIssueError,
  UnfinishedWorkItemExistsError,
  WORK_ITEM_LIFECYCLE_QUEUE,
  WorkItemLifecycle,
  WorkItemLifecycleLive,
  WorkItemNotFoundError,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("WorkItemLifecycle", () => {
  const successfulSteps: LifecycleStepsShape = {
    createWorktree: () => Effect.succeed("/tmp/worktrees/acme-widgets-42"),
    installDependencies: () => Effect.void,
    implement: () => Effect.succeed("ses_test_implement_session"),
    review: () => Effect.void,
  }

  const SuccessfulStepsLive = Layer.succeed(
    LifecycleSteps,
    LifecycleSteps.of(successfulSteps),
  )

  const TestLayer = WorkItemLifecycleLive.pipe(
    Layer.provideMerge(SuccessfulStepsLive),
    Layer.provideMerge(DbServiceLive),
    Layer.provideMerge(SqliteQueueServiceLive),
    Layer.provideMerge(DatabaseTest),
  )

  type TestRequirements = Layer.Layer.Success<typeof TestLayer>

  const runTest = <A, E>(
    test: Effect.Effect<A, E, TestRequirements>,
  ): Promise<A> => Effect.runPromise(Effect.provide(test, TestLayer))

  const makeTestLayer = (steps: LifecycleStepsShape) =>
    WorkItemLifecycleLive.pipe(
      Layer.provideMerge(
        Layer.succeed(LifecycleSteps, LifecycleSteps.of(steps)),
      ),
      Layer.provideMerge(DbServiceLive),
      Layer.provideMerge(SqliteQueueServiceLive),
      Layer.provideMerge(DatabaseTest),
    )

  const runWithSteps = <A, E>(
    steps: LifecycleStepsShape,
    test: Effect.Effect<A, E, TestRequirements>,
  ): Promise<A> => Effect.runPromise(Effect.provide(test, makeTestLayer(steps)))

  const sampleRepository = {
    githubOwner: "acme",
    githubRepo: "widgets",
    localPath: "/repos/acme/widgets.git",
    isBare: true,
  }

  const sampleIssueFields = {
    title: "Implement feature",
    body: "Issue body",
    url: "https://github.com/acme/widgets/issues/42",
    state: "OPEN" as const,
    githubCreatedAt: new Date("2026-01-15T12:00:00.000Z"),
    parent: null,
    parentPosition: null,
    hasChildren: false,
    blockedBy: [],
  }

  const seedActionableIssue = Effect.gen(function* () {
    const db = yield* DbService
    const repository = yield* db.addRepository(sampleRepository)
    const issue = yield* db.storeIssue({
      repositoryId: repository.id,
      githubIssueNumber: 42,
      ...sampleIssueFields,
    })
    return { repository, issue }
  })

  describe("implementNow", () => {
    it("creates a Work Item at Create Worktree for an actionable Issue on a paused Repository", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const queue = yield* QueueService
          const db = yield* DbService
          const { repository, issue } = yield* seedActionableIssue

          expect(repository.paused).toBe(true)

          const workItem = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )

          expect(workItem.id).toMatch(/^wi-[0-9A-HJKMNP-TV-Z]{26}$/)
          expect(workItem.repositoryId).toBe(repository.id)
          expect(workItem.githubIssueNumber).toBe(42)
          expect(workItem.state).toBe("create_worktree")
          expect(workItem.model).toBe("opencode/deepseek-v4-flash-free")
          expect(workItem.variant).toBe("low")
          expect(workItem.worktreePath).toBeNull()
          expect(workItem.sessionId).toBeNull()
          expect(workItem.failureCode).toBeNull()
          expect(workItem.failureMessage).toBeNull()
          expect(workItem.stepRuns).toHaveLength(1)

          const stepRun = workItem.stepRuns[0]!
          expect(stepRun.id).toMatch(/^srun-[0-9A-HJKMNP-TV-Z]{26}$/)
          expect(stepRun.workItemId).toBe(workItem.id)
          expect(stepRun.step).toBe("create_worktree")
          expect(stepRun.status).toBe("queued")
          expect(stepRun.queueJobId).toMatch(/^qjob-[0-9A-HJKMNP-TV-Z]{26}$/)
          expect(stepRun.startedAt).toBeNull()
          expect(stepRun.finishedAt).toBeNull()

          const claimed = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
          expect(Option.isSome(claimed)).toBe(true)
          if (Option.isSome(claimed)) {
            expect(claimed.value.jobId).toBe(stepRun.queueJobId)
            expect(claimed.value.payload).toEqual({
              _tag: "work-item-step",
              stepRunId: stepRun.id,
            })
          }

          const config = yield* db.getConfig
          expect(workItem.model).toBe(config.defaultModel)
          expect(workItem.variant).toBe(config.defaultVariant)
        }),
      ))

    it("captures the current default model and variant at creation", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const db = yield* DbService
          const { repository, issue } = yield* seedActionableIssue

          yield* db.updateConfig({
            defaultModel: "anthropic/claude-sonnet-4-5",
            defaultVariant: "high",
          })

          const workItem = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )

          expect(workItem.model).toBe("anthropic/claude-sonnet-4-5")
          expect(workItem.variant).toBe("high")
        }),
      ))

    it("rejects a missing Issue", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const db = yield* DbService
          const repository = yield* db.addRepository(sampleRepository)

          const error = yield* Effect.flip(
            lifecycle.implementNow(repository.id, 999),
          )

          expect(error).toBeInstanceOf(IssueNotFoundError)
          if (error instanceof IssueNotFoundError) {
            expect(error.repositoryId).toBe(repository.id)
            expect(error.githubIssueNumber).toBe(999)
          }
        }),
      ))

    it("rejects a closed Issue", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const db = yield* DbService
          const repository = yield* db.addRepository(sampleRepository)
          yield* db.storeIssue({
            repositoryId: repository.id,
            githubIssueNumber: 7,
            ...sampleIssueFields,
            state: "CLOSED",
            url: "https://github.com/acme/widgets/issues/7",
          })

          const error = yield* Effect.flip(
            lifecycle.implementNow(repository.id, 7),
          )

          expect(error).toBeInstanceOf(IssueNotOpenError)
        }),
      ))

    it("rejects a Parent Issue", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const db = yield* DbService
          const repository = yield* db.addRepository(sampleRepository)
          yield* db.storeIssue({
            repositoryId: repository.id,
            githubIssueNumber: 1,
            ...sampleIssueFields,
            title: "Parent",
            url: "https://github.com/acme/widgets/issues/1",
            hasChildren: true,
          })

          const error = yield* Effect.flip(
            lifecycle.implementNow(repository.id, 1),
          )

          expect(error).toBeInstanceOf(ParentIssueError)
        }),
      ))

    it("rejects a blocked Issue", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const db = yield* DbService
          const repository = yield* db.addRepository(sampleRepository)
          yield* db.storeIssue({
            repositoryId: repository.id,
            githubIssueNumber: 3,
            ...sampleIssueFields,
            url: "https://github.com/acme/widgets/issues/3",
            blockedBy: [
              {
                githubIssueNumber: 2,
                githubIssueUrl: "https://github.com/acme/widgets/issues/2",
              },
            ],
          })

          const error = yield* Effect.flip(
            lifecycle.implementNow(repository.id, 3),
          )

          expect(error).toBeInstanceOf(IssueBlockedError)
          if (error instanceof IssueBlockedError) {
            expect(error.blockerCount).toBe(1)
          }
        }),
      ))

    it("rejects a second unfinished Work Item for the same Issue", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const { repository, issue } = yield* seedActionableIssue

          const first = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          const error = yield* Effect.flip(
            lifecycle.implementNow(repository.id, issue.githubIssueNumber),
          )

          expect(error).toBeInstanceOf(UnfinishedWorkItemExistsError)
          if (error instanceof UnfinishedWorkItemExistsError) {
            expect(error.workItemId).toBe(first.id)
          }
        }),
      ))

    it("permits at most one unfinished Work Item under concurrent implementNow", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const { repository, issue } = yield* seedActionableIssue

          const results = yield* Effect.all(
            [
              lifecycle
                .implementNow(repository.id, issue.githubIssueNumber)
                .pipe(Effect.result),
              lifecycle
                .implementNow(repository.id, issue.githubIssueNumber)
                .pipe(Effect.result),
            ],
            { concurrency: "unbounded" },
          )

          const successes = results.filter((result) => Result.isSuccess(result))
          const failures = results.filter((result) => Result.isFailure(result))

          expect(successes).toHaveLength(1)
          expect(failures).toHaveLength(1)
          const listed = yield* lifecycle.listWorkItemsForIssue(
            repository.id,
            issue.githubIssueNumber,
          )
          expect(listed).toHaveLength(1)
          expect(listed[0]!.stepRuns).toHaveLength(1)

          if (Result.isSuccess(successes[0]!)) {
            expect(listed[0]!.id).toBe(successes[0].success.id)
          }
          if (Result.isFailure(failures[0]!)) {
            expect(failures[0].failure).toBeInstanceOf(
              UnfinishedWorkItemExistsError,
            )
            if (failures[0].failure instanceof UnfinishedWorkItemExistsError) {
              expect(failures[0].failure.workItemId).toBe(listed[0]!.id)
            }
          }
        }),
      ))

    it("rolls back when enqueue fails mid-transaction", () => {
      let enqueueCalls = 0
      const failingEnqueueQueue: QueueServiceShape = {
        queueInTransaction: true,
        enqueue: () => {
          enqueueCalls += 1
          return Effect.fail(
            new EnqueueError({
              queue: WORK_ITEM_LIFECYCLE_QUEUE,
              message: "injected enqueue failure",
            }),
          )
        },
        enqueueWithDelay: () =>
          Effect.die("enqueueWithDelay should not be called") as Effect.Effect<
            JobId,
            never
          >,
        rawClaim: () => Effect.succeed(Option.none()),
        acknowledge: () => Effect.void,
        fail: () => Effect.void,
        extendVisibility: () => Effect.void,
        getStats: () =>
          Effect.succeed({ pending: 0, processing: 0, deadLetter: 0 }),
      }

      const layer = WorkItemLifecycleLive.pipe(
        Layer.provideMerge(SuccessfulStepsLive),
        Layer.provideMerge(DbServiceLive),
        Layer.provideMerge(
          Layer.succeed(QueueService, QueueService.of(failingEnqueueQueue)),
        ),
        Layer.provideMerge(DatabaseTest),
      )

      return Effect.runPromise(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const db = yield* DbService
          const repository = yield* db.addRepository(sampleRepository)
          yield* db.storeIssue({
            repositoryId: repository.id,
            githubIssueNumber: 42,
            ...sampleIssueFields,
          })

          const error = yield* Effect.flip(
            lifecycle.implementNow(repository.id, 42),
          )
          expect(error).toBeInstanceOf(EnqueueError)
          expect(enqueueCalls).toBe(1)

          const listed = yield* lifecycle.listWorkItemsForIssue(
            repository.id,
            42,
          )
          expect(listed).toEqual([])
        }).pipe(Effect.provide(layer)),
      )
    })
  })

  describe("getWorkItem and listWorkItemsForIssue", () => {
    it("retrieves a Work Item with its initial Step Run", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const { repository, issue } = yield* seedActionableIssue

          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          const retrieved = yield* lifecycle.getWorkItem(created.id)

          expect(retrieved.id).toBe(created.id)
          expect(retrieved.stepRuns).toHaveLength(1)
          expect(retrieved.stepRuns[0]!.id).toBe(created.stepRuns[0]!.id)
        }),
      ))

    it("lists Work Items for an Issue in creation order", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const sql = yield* SqlClient.SqlClient
          const { repository, issue } = yield* seedActionableIssue

          const first = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )

          // Terminalize via SQL so a second Implement Now is allowed; abandon/retry
          // are later tickets and are not part of this package's public surface yet.
          yield* sql.unsafe(
            `UPDATE work_item SET state = 'abandoned', updated_at = ? WHERE id = ?`,
            [Date.now(), first.id],
          )
          yield* Effect.sleep("2 millis")

          const second = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )

          const listed = yield* lifecycle.listWorkItemsForIssue(
            repository.id,
            issue.githubIssueNumber,
          )

          expect(listed.map((item) => item.id)).toEqual([first.id, second.id])
          expect(listed[0]!.state).toBe("abandoned")
          expect(listed[1]!.state).toBe("create_worktree")
          expect(listed[1]!.stepRuns).toHaveLength(1)
        }),
      ))

    it("rejects getWorkItem for an unknown id", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const error = yield* Effect.flip(
            lifecycle.getWorkItem("wi-01ARZ3NDEKTSV4RRFFQ69G5FAV"),
          )
          expect(error).toBeInstanceOf(WorkItemNotFoundError)
        }),
      ))
  })

  describe("queue requirements", () => {
    it("rejects construction when QueueService is not transactional", async () => {
      const nonTransactionalQueue: QueueServiceShape = {
        queueInTransaction: false,
        enqueue: () =>
          Effect.die("enqueue should not be called") as Effect.Effect<
            JobId,
            never
          >,
        enqueueWithDelay: () =>
          Effect.die("enqueueWithDelay should not be called") as Effect.Effect<
            JobId,
            never
          >,
        rawClaim: () => Effect.succeed(Option.none()),
        acknowledge: () => Effect.void,
        fail: () => Effect.void,
        extendVisibility: () => Effect.void,
        getStats: () =>
          Effect.succeed({ pending: 0, processing: 0, deadLetter: 0 }),
      }

      const NonTransactionalQueueLive = Layer.succeed(
        QueueService,
        QueueService.of(nonTransactionalQueue),
      )

      const layer = WorkItemLifecycleLive.pipe(
        Layer.provideMerge(SuccessfulStepsLive),
        Layer.provideMerge(DbServiceLive),
        Layer.provideMerge(NonTransactionalQueueLive),
        Layer.provideMerge(DatabaseTest),
      )

      const result = await Effect.runPromiseExit(
        Effect.gen(function* () {
          yield* WorkItemLifecycle
        }).pipe(Effect.provide(layer)),
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        const failure = Cause.findErrorOption(result.cause)
        expect(Option.isSome(failure)).toBe(true)
        if (Option.isSome(failure)) {
          expect(failure.value).toBeInstanceOf(NonTransactionalQueueError)
        }
      }
    })
  })

  describe("runStep", () => {
    const claimAndRunPending = Effect.gen(function* () {
      const lifecycle = yield* WorkItemLifecycle
      const queue = yield* QueueService
      const claimed = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
      expect(Option.isSome(claimed)).toBe(true)
      if (Option.isNone(claimed)) {
        return yield* Effect.die("expected a queued lifecycle job")
      }
      const payload = claimed.value.payload as { stepRunId: string }
      const result = yield* lifecycle.runStep(payload.stepRunId)
      return result
    })

    it("drives the complete happy path to Complete with typed outputs", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const { repository, issue } = yield* seedActionableIssue

          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          expect(created.state).toBe("create_worktree")
          expect(created.stepRuns).toHaveLength(1)

          const afterCreate = yield* claimAndRunPending
          expect(afterCreate._tag).toBe("processed")
          if (afterCreate._tag === "processed") {
            expect(afterCreate.workItem.state).toBe("install_dependencies")
            expect(afterCreate.workItem.worktreePath).toBe(
              "/tmp/worktrees/acme-widgets-42",
            )
            expect(afterCreate.workItem.sessionId).toBeNull()
            expect(
              afterCreate.workItem.stepRuns.map((run) => run.status),
            ).toEqual(["succeeded", "queued"])
            expect(afterCreate.workItem.stepRuns[0]!.step).toBe(
              "create_worktree",
            )
            expect(afterCreate.workItem.stepRuns[1]!.step).toBe(
              "install_dependencies",
            )
          }

          const afterInstall = yield* claimAndRunPending
          expect(afterInstall._tag).toBe("processed")
          if (afterInstall._tag === "processed") {
            expect(afterInstall.workItem.state).toBe("implement")
            expect(afterInstall.workItem.worktreePath).toBe(
              "/tmp/worktrees/acme-widgets-42",
            )
          }

          const afterImplement = yield* claimAndRunPending
          expect(afterImplement._tag).toBe("processed")
          if (afterImplement._tag === "processed") {
            expect(afterImplement.workItem.state).toBe("review")
            expect(afterImplement.workItem.sessionId).toBe(
              "ses_test_implement_session",
            )
          }

          const afterReview = yield* claimAndRunPending
          expect(afterReview._tag).toBe("processed")
          if (afterReview._tag === "processed") {
            expect(afterReview.workItem.state).toBe("complete")
            expect(afterReview.workItem.worktreePath).toBe(
              "/tmp/worktrees/acme-widgets-42",
            )
            expect(afterReview.workItem.sessionId).toBe(
              "ses_test_implement_session",
            )
            expect(afterReview.workItem.failureCode).toBeNull()
            expect(
              afterReview.workItem.stepRuns.map((run) => [
                run.step,
                run.status,
              ]),
            ).toEqual([
              ["create_worktree", "succeeded"],
              ["install_dependencies", "succeeded"],
              ["implement", "succeeded"],
              ["review", "succeeded"],
            ])
          }

          const queue = yield* QueueService
          const remaining = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
          expect(Option.isNone(remaining)).toBe(true)

          const final = yield* lifecycle.getWorkItem(created.id)
          expect(final.state).toBe("complete")
          expect(final.stepRuns).toHaveLength(4)
        }),
      ))

    it("supplies worktree path, session, model, and variant to later handlers", () => {
      const seen: LifecycleStepContext[] = []
      const recordingSteps: LifecycleStepsShape = {
        createWorktree: (context) => {
          seen.push(context)
          return Effect.succeed("/tmp/worktrees/recorded")
        },
        installDependencies: (context) => {
          seen.push(context)
          return Effect.void
        },
        implement: (context) => {
          seen.push(context)
          return Effect.succeed("ses_recorded")
        },
        review: (context) => {
          seen.push(context)
          return Effect.void
        },
      }

      return runWithSteps(
        recordingSteps,
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const db = yield* DbService
          const { repository, issue } = yield* seedActionableIssue

          yield* db.updateConfig({
            defaultModel: "anthropic/claude-sonnet-4-5",
            defaultVariant: "high",
          })

          yield* lifecycle.implementNow(repository.id, issue.githubIssueNumber)
          yield* claimAndRunPending
          yield* claimAndRunPending
          yield* claimAndRunPending
          yield* claimAndRunPending

          expect(seen).toHaveLength(4)
          expect(seen[0]!.worktreePath).toBeNull()
          expect(seen[0]!.sessionId).toBeNull()
          expect(seen[0]!.model).toBe("anthropic/claude-sonnet-4-5")
          expect(seen[0]!.variant).toBe("high")

          expect(seen[1]!.worktreePath).toBe("/tmp/worktrees/recorded")
          expect(seen[1]!.sessionId).toBeNull()

          expect(seen[2]!.worktreePath).toBe("/tmp/worktrees/recorded")
          expect(seen[2]!.sessionId).toBeNull()
          expect(seen[2]!.model).toBe("anthropic/claude-sonnet-4-5")
          expect(seen[2]!.variant).toBe("high")

          expect(seen[3]!.worktreePath).toBe("/tmp/worktrees/recorded")
          expect(seen[3]!.sessionId).toBe("ses_recorded")
          expect(seen[3]!.model).toBe("anthropic/claude-sonnet-4-5")
          expect(seen[3]!.variant).toBe("high")
        }),
      )
    })

    it("completes Review on command success without interpreting findings", () => {
      let reviewCalls = 0
      const stepsWithFindings: LifecycleStepsShape = {
        ...successfulSteps,
        review: () => {
          reviewCalls += 1
          // Handler success alone advances; findings are not a lifecycle gate.
          return Effect.void
        },
      }

      return runWithSteps(
        stepsWithFindings,
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const { repository, issue } = yield* seedActionableIssue
          yield* lifecycle.implementNow(repository.id, issue.githubIssueNumber)
          yield* claimAndRunPending
          yield* claimAndRunPending
          yield* claimAndRunPending
          const afterReview = yield* claimAndRunPending

          expect(reviewCalls).toBe(1)
          expect(afterReview._tag).toBe("processed")
          if (afterReview._tag === "processed") {
            expect(afterReview.workItem.state).toBe("complete")
          }
        }),
      )
    })

    it("fails the Work Item terminally when the Issue is deleted after a successful Effect", () => {
      let createCalls = 0
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        createWorktree: () => {
          createCalls += 1
          return Effect.succeed("/tmp/worktrees/deleted-issue")
        },
      }

      return runWithSteps(
        steps,
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const db = yield* DbService
          const { repository, issue } = yield* seedActionableIssue

          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )

          yield* db.deleteIssue(repository.id, issue.githubIssueNumber)
          yield* Effect.sleep("5 millis")

          const result = yield* claimAndRunPending
          expect(createCalls).toBe(1)
          expect(result._tag).toBe("processed")
          if (result._tag === "processed") {
            expect(result.workItem.state).toBe("failed")
            expect(result.workItem.failureCode).toBe("issue_not_found")
            expect(result.workItem.stateReadyAt.getTime()).toBeGreaterThan(
              created.stateReadyAt.getTime(),
            )
            expect(result.workItem.worktreePath).toBe(
              "/tmp/worktrees/deleted-issue",
            )
            expect(result.workItem.stepRuns).toHaveLength(1)
            expect(result.workItem.stepRuns[0]!.status).toBe("succeeded")
          }

          const queue = yield* QueueService
          const remaining = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
          expect(Option.isNone(remaining)).toBe(true)

          const final = yield* lifecycle.getWorkItem(created.id)
          expect(final.state).toBe("failed")
          expect(final.stepRuns[0]!.status).toBe("succeeded")
        }),
      )
    })

    it("fails terminally when the Issue becomes closed, blocked, or a Parent after success", () => {
      const cases = [
        {
          name: "closed",
          mutate: (repositoryId: string, githubIssueNumber: number) =>
            Effect.gen(function* () {
              const db = yield* DbService
              yield* db.storeIssue({
                repositoryId,
                githubIssueNumber,
                ...sampleIssueFields,
                state: "CLOSED",
                url: `https://github.com/acme/widgets/issues/${githubIssueNumber}`,
              })
            }),
          code: "issue_not_open",
        },
        {
          name: "parent",
          mutate: (repositoryId: string, githubIssueNumber: number) =>
            Effect.gen(function* () {
              const db = yield* DbService
              yield* db.storeIssue({
                repositoryId,
                githubIssueNumber,
                ...sampleIssueFields,
                hasChildren: true,
                url: `https://github.com/acme/widgets/issues/${githubIssueNumber}`,
              })
            }),
          code: "issue_is_parent",
        },
        {
          name: "blocked",
          mutate: (repositoryId: string, githubIssueNumber: number) =>
            Effect.gen(function* () {
              const db = yield* DbService
              yield* db.storeIssue({
                repositoryId,
                githubIssueNumber,
                ...sampleIssueFields,
                blockedBy: [
                  {
                    githubIssueNumber: 99,
                    githubIssueUrl: "https://github.com/acme/widgets/issues/99",
                  },
                ],
                url: `https://github.com/acme/widgets/issues/${githubIssueNumber}`,
              })
            }),
          code: "issue_blocked",
        },
      ] as const

      return Effect.runPromise(
        Effect.gen(function* () {
          for (const testCase of cases) {
            yield* Effect.gen(function* () {
              const lifecycle = yield* WorkItemLifecycle
              const { repository, issue } = yield* seedActionableIssue
              yield* lifecycle.implementNow(
                repository.id,
                issue.githubIssueNumber,
              )
              yield* testCase.mutate(repository.id, issue.githubIssueNumber)
              const result = yield* claimAndRunPending
              expect(result._tag).toBe("processed")
              if (result._tag === "processed") {
                expect(result.workItem.state).toBe("failed")
                expect(result.workItem.failureCode).toBe(testCase.code)
                expect(result.workItem.stepRuns[0]!.status).toBe("succeeded")
              }
            }).pipe(Effect.provide(TestLayer))
          }
        }),
      )
    })

    it("accepts an Issue projection deleted and restored under the same identity", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const db = yield* DbService
          const { repository, issue } = yield* seedActionableIssue

          yield* lifecycle.implementNow(repository.id, issue.githubIssueNumber)

          yield* db.deleteIssue(repository.id, issue.githubIssueNumber)
          yield* db.storeIssue({
            repositoryId: repository.id,
            githubIssueNumber: issue.githubIssueNumber,
            ...sampleIssueFields,
            title: "Restored projection",
            body: "New local row, same GitHub identity",
          })

          const result = yield* claimAndRunPending
          expect(result._tag).toBe("processed")
          if (result._tag === "processed") {
            expect(result.workItem.state).toBe("install_dependencies")
            expect(result.workItem.failureCode).toBeNull()
            expect(result.workItem.worktreePath).toBe(
              "/tmp/worktrees/acme-widgets-42",
            )
          }
        }),
      ))

    it("returns noop for a Step Run that is not Queued matching the pending state", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const { repository, issue } = yield* seedActionableIssue
          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          const stepRunId = created.stepRuns[0]!.id

          const first = yield* lifecycle.runStep(stepRunId)
          expect(first._tag).toBe("processed")

          const second = yield* lifecycle.runStep(stepRunId)
          expect(second).toEqual({ _tag: "noop" })
        }),
      ))

    it("executes a concurrently delivered Step Run only once", () => {
      let createCalls = 0
      const slowSteps: LifecycleStepsShape = {
        ...successfulSteps,
        createWorktree: () =>
          Effect.gen(function* () {
            createCalls += 1
            yield* Effect.sleep("20 millis")
            return "/tmp/worktrees/concurrent"
          }),
      }

      return runWithSteps(
        slowSteps,
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const { repository, issue } = yield* seedActionableIssue
          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          const stepRunId = created.stepRuns[0]!.id

          const results = yield* Effect.all(
            [lifecycle.runStep(stepRunId), lifecycle.runStep(stepRunId)],
            { concurrency: "unbounded" },
          )

          expect(createCalls).toBe(1)
          expect(results.map((result) => result._tag).sort()).toEqual([
            "noop",
            "processed",
          ])
          const workItem = yield* lifecycle.getWorkItem(created.id)
          expect(workItem.state).toBe("install_dependencies")
          expect(workItem.stepRuns).toHaveLength(2)
        }),
      )
    })

    it("rolls back advancement when next-step enqueue fails", () => {
      let enqueueCalls = 0
      const queueShape: QueueServiceShape = {
        queueInTransaction: true,
        enqueue: (_queue, _payload) => {
          enqueueCalls += 1
          // First enqueue is implementNow; second is advancement after create worktree.
          if (enqueueCalls === 1) {
            return Effect.succeed(`qjob-01ARZ3NDEKTSV4RRFFQ69G5FAV` as JobId)
          }
          return Effect.fail(
            new EnqueueError({
              queue: WORK_ITEM_LIFECYCLE_QUEUE,
              message: "injected advancement enqueue failure",
            }),
          )
        },
        enqueueWithDelay: () =>
          Effect.die("enqueueWithDelay should not be called") as Effect.Effect<
            JobId,
            never
          >,
        rawClaim: () => Effect.succeed(Option.none()),
        acknowledge: () => Effect.void,
        fail: () => Effect.void,
        extendVisibility: () => Effect.void,
        getStats: () =>
          Effect.succeed({ pending: 0, processing: 0, deadLetter: 0 }),
      }

      // Real DB + fake queue so we can fail the post-success enqueue.
      // Step run is started via runStep using the id from implementNow.
      const layer = WorkItemLifecycleLive.pipe(
        Layer.provideMerge(SuccessfulStepsLive),
        Layer.provideMerge(DbServiceLive),
        Layer.provideMerge(
          Layer.succeed(QueueService, QueueService.of(queueShape)),
        ),
        Layer.provideMerge(DatabaseTest),
      )

      return Effect.runPromise(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const db = yield* DbService
          const repository = yield* db.addRepository(sampleRepository)
          yield* db.storeIssue({
            repositoryId: repository.id,
            githubIssueNumber: 42,
            ...sampleIssueFields,
          })

          const created = yield* lifecycle.implementNow(repository.id, 42)
          const stepRunId = created.stepRuns[0]!.id

          const error = yield* Effect.flip(lifecycle.runStep(stepRunId))
          expect(error).toBeInstanceOf(EnqueueError)
          expect(enqueueCalls).toBe(2)

          const after = yield* lifecycle.getWorkItem(created.id)
          // Transaction rolled back: no partial advancement or succeeded run.
          expect(after.state).toBe("create_worktree")
          expect(after.worktreePath).toBeNull()
          expect(after.stepRuns).toHaveLength(1)
          // Start happened outside the completion transaction; status may be
          // running after a failed completion commit. Advancement outputs and
          // next step must not be visible.
          expect(after.stepRuns[0]!.status).not.toBe("succeeded")
          expect(after.stepRuns[0]!.finishedAt).toBeNull()
        }).pipe(Effect.provide(layer)),
      )
    })
  })
})
