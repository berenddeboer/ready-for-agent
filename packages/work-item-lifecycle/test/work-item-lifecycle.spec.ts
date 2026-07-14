import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Result,
} from "effect"
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
  ActiveStepRunExistsError,
  IssueBlockedError,
  IssueNotFoundError,
  IssueNotOpenError,
  type LifecycleStepContext,
  LifecycleSteps,
  type LifecycleStepsShape,
  NonTransactionalQueueError,
  ParentIssueError,
  RetryNotEligibleError,
  STEP_RUN_REASON,
  UnfinishedWorkItemExistsError,
  WORK_ITEM_LIFECYCLE_QUEUE,
  WorkItemHasRunningStepError,
  WorkItemLifecycle,
  WorkItemLifecycleLive,
  WorkItemNotFoundError,
  WorkItemTerminalError,
  makeWorkItemLifecycleLive,
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
          const { repository, issue } = yield* seedActionableIssue

          const first = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )

          yield* lifecycle.abandon(first.id)
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

    it("records typed handler failure as Failed Step Run and leaves the pending step", () => {
      const failingSteps: LifecycleStepsShape = {
        ...successfulSteps,
        createWorktree: () => Effect.fail(new Error("worktree path busy")),
      }

      return runWithSteps(
        failingSteps,
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const queue = yield* QueueService
          const { repository, issue } = yield* seedActionableIssue

          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          const result = yield* claimAndRunPending

          expect(result._tag).toBe("processed")
          if (result._tag === "processed") {
            expect(result.workItem.state).toBe("create_worktree")
            expect(result.workItem.stepRuns).toHaveLength(1)
            const run = result.workItem.stepRuns[0]!
            expect(run.status).toBe("failed")
            expect(run.reasonCode).toBe(STEP_RUN_REASON.handlerFailed)
            expect(run.reasonMessage).toContain("worktree path busy")
            expect(run.queuedAt).toBeInstanceOf(Date)
            expect(run.startedAt).toBeInstanceOf(Date)
            expect(run.finishedAt).toBeInstanceOf(Date)
            expect(run.finishedAt!.getTime()).toBeGreaterThanOrEqual(
              run.startedAt!.getTime(),
            )
          }

          const remaining = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
          expect(Option.isNone(remaining)).toBe(true)

          const final = yield* lifecycle.getWorkItem(created.id)
          expect(final.state).toBe("create_worktree")
          expect(final.stepRuns).toHaveLength(1)
          expect(final.stepRuns[0]!.status).toBe("failed")
        }),
      )
    })

    it("records handler defects as Failed with a stable defect reason", () => {
      const defectSteps: LifecycleStepsShape = {
        ...successfulSteps,
        createWorktree: () => Effect.die("unexpected boom"),
      }

      return runWithSteps(
        defectSteps,
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const { repository, issue } = yield* seedActionableIssue

          yield* lifecycle.implementNow(repository.id, issue.githubIssueNumber)
          const result = yield* claimAndRunPending

          expect(result._tag).toBe("processed")
          if (result._tag === "processed") {
            expect(result.workItem.state).toBe("create_worktree")
            const run = result.workItem.stepRuns[0]!
            expect(run.status).toBe("failed")
            expect(run.reasonCode).toBe(STEP_RUN_REASON.handlerDefect)
            expect(run.reasonMessage).toContain("unexpected boom")
            expect(run.finishedAt).toBeInstanceOf(Date)
          }
        }),
      )
    })

    it("records a synchronous handler throw as a Failed defect", () => {
      const throwingSteps: LifecycleStepsShape = {
        ...successfulSteps,
        createWorktree: () => {
          throw new Error("handler construction exploded")
        },
      }

      return runWithSteps(
        throwingSteps,
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const queue = yield* QueueService
          const { repository, issue } = yield* seedActionableIssue

          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          const result = yield* claimAndRunPending

          expect(result._tag).toBe("processed")
          if (result._tag === "processed") {
            const run = result.workItem.stepRuns[0]!
            expect(result.workItem.state).toBe("create_worktree")
            expect(run.status).toBe("failed")
            expect(run.reasonCode).toBe(STEP_RUN_REASON.handlerDefect)
            expect(run.reasonMessage).toContain("handler construction exploded")
            expect(run.finishedAt).toBeInstanceOf(Date)
          }

          const remaining = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
          expect(Option.isNone(remaining)).toBe(true)
          expect(
            (yield* lifecycle.getWorkItem(created.id)).stepRuns[0]!.status,
          ).toBe("failed")
        }),
      )
    })

    it("interrupts a slow handler and records Failed with a timeout reason", () => {
      const slowSteps: LifecycleStepsShape = {
        ...successfulSteps,
        createWorktree: () =>
          Effect.gen(function* () {
            yield* Effect.sleep("200 millis")
            return "/tmp/worktrees/too-slow"
          }),
      }

      const layer = makeWorkItemLifecycleLive({
        maxDurations: {
          create_worktree: Duration.millis(20),
          install_dependencies: Duration.minutes(15),
          implement: Duration.hours(2),
          review: Duration.hours(1),
        },
      }).pipe(
        Layer.provideMerge(
          Layer.succeed(LifecycleSteps, LifecycleSteps.of(slowSteps)),
        ),
        Layer.provideMerge(DbServiceLive),
        Layer.provideMerge(SqliteQueueServiceLive),
        Layer.provideMerge(DatabaseTest),
      )

      return Effect.runPromise(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const queue = yield* QueueService
          const { repository, issue } = yield* seedActionableIssue

          expect(
            Duration.toMillis(lifecycle.maxDurations.create_worktree),
          ).toBe(20)

          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          const claimed = yield* queue.rawClaim(
            WORK_ITEM_LIFECYCLE_QUEUE,
            lifecycle.maxDurations.create_worktree,
          )
          expect(Option.isSome(claimed)).toBe(true)
          if (Option.isNone(claimed)) {
            return yield* Effect.die("expected lifecycle job")
          }

          const result = yield* lifecycle.runStep(
            (claimed.value.payload as { stepRunId: string }).stepRunId,
          )

          expect(result._tag).toBe("processed")
          if (result._tag === "processed") {
            expect(result.workItem.state).toBe("create_worktree")
            const run = result.workItem.stepRuns[0]!
            expect(run.status).toBe("failed")
            expect(run.reasonCode).toBe(STEP_RUN_REASON.timeout)
            expect(run.reasonMessage.toLowerCase()).toContain("maximum")
            expect(run.finishedAt).toBeInstanceOf(Date)
          }

          const remaining = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
          expect(Option.isNone(remaining)).toBe(true)

          const final = yield* lifecycle.getWorkItem(created.id)
          expect(final.state).toBe("create_worktree")
          expect(final.stepRuns[0]!.reasonCode).toBe(STEP_RUN_REASON.timeout)
        }).pipe(Effect.provide(layer)),
      )
    })
  })

  describe("retry", () => {
    const claimAndRunPending = Effect.gen(function* () {
      const lifecycle = yield* WorkItemLifecycle
      const queue = yield* QueueService
      const claimed = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
      expect(Option.isSome(claimed)).toBe(true)
      if (Option.isNone(claimed)) {
        return yield* Effect.die("expected a queued lifecycle job")
      }
      const payload = claimed.value.payload as { stepRunId: string }
      return yield* lifecycle.runStep(payload.stepRunId)
    })

    it("creates a new Queued Step Run for a Failed pending step without changing state", () => {
      let attempts = 0
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        createWorktree: () => {
          attempts += 1
          if (attempts === 1) {
            return Effect.fail(new Error("first attempt failed"))
          }
          return Effect.succeed("/tmp/worktrees/retry-success")
        },
      }

      return runWithSteps(
        steps,
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const queue = yield* QueueService
          const { repository, issue } = yield* seedActionableIssue

          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          const failed = yield* claimAndRunPending
          expect(failed._tag).toBe("processed")
          if (failed._tag === "processed") {
            expect(failed.workItem.stepRuns[0]!.status).toBe("failed")
          }

          const retried = yield* lifecycle.retry(created.id)
          expect(retried.state).toBe("create_worktree")
          expect(retried.stepRuns).toHaveLength(2)
          expect(retried.stepRuns[0]!.status).toBe("failed")
          expect(retried.stepRuns[0]!.reasonCode).toBe(
            STEP_RUN_REASON.handlerFailed,
          )
          expect(retried.stepRuns[1]!.status).toBe("queued")
          expect(retried.stepRuns[1]!.step).toBe("create_worktree")
          expect(retried.stepRuns[1]!.id).not.toBe(retried.stepRuns[0]!.id)
          expect(retried.stepRuns[1]!.queueJobId).toMatch(
            /^qjob-[0-9A-HJKMNP-TV-Z]{26}$/,
          )

          const afterRetry = yield* claimAndRunPending
          expect(afterRetry._tag).toBe("processed")
          if (afterRetry._tag === "processed") {
            expect(afterRetry.workItem.state).toBe("install_dependencies")
            expect(afterRetry.workItem.worktreePath).toBe(
              "/tmp/worktrees/retry-success",
            )
            expect(
              afterRetry.workItem.stepRuns.map((run) => [run.step, run.status]),
            ).toEqual([
              ["create_worktree", "failed"],
              ["create_worktree", "succeeded"],
              ["install_dependencies", "queued"],
            ])
          }

          const remaining = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
          expect(Option.isSome(remaining)).toBe(true)
        }),
      )
    })

    it("retains every prior Step Run across multiple retries", () => {
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        createWorktree: () => Effect.fail(new Error("still failing")),
      }

      return runWithSteps(
        steps,
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const { repository, issue } = yield* seedActionableIssue

          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          yield* claimAndRunPending
          yield* lifecycle.retry(created.id)
          yield* claimAndRunPending
          const afterSecondFail = yield* lifecycle.retry(created.id)

          expect(afterSecondFail.state).toBe("create_worktree")
          expect(afterSecondFail.stepRuns).toHaveLength(3)
          expect(afterSecondFail.stepRuns.map((run) => run.status)).toEqual([
            "failed",
            "failed",
            "queued",
          ])
          expect(afterSecondFail.stepRuns[0]!.reasonMessage).toContain(
            "still failing",
          )
          expect(afterSecondFail.stepRuns[1]!.reasonMessage).toContain(
            "still failing",
          )
          expect(afterSecondFail.stepRuns[0]!.finishedAt).not.toBeNull()
          expect(afterSecondFail.stepRuns[1]!.finishedAt).not.toBeNull()
        }),
      )
    })

    it("accepts retry after an Interrupted latest attempt for the pending step", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const sql = yield* SqlClient.SqlClient
          const { repository, issue } = yield* seedActionableIssue

          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          const stepRunId = created.stepRuns[0]!.id
          const now = Date.now()

          yield* sql.unsafe(
            `UPDATE step_run
             SET status = 'interrupted',
                 started_at = ?,
                 finished_at = ?,
                 reason_code = 'interrupted',
                 reason_message = 'worker lost',
                 updated_at = ?
             WHERE id = ?`,
            [now, now, now, stepRunId],
          )
          yield* Effect.sleep("2 millis")

          const retried = yield* lifecycle.retry(created.id)
          expect(retried.state).toBe("create_worktree")
          expect(retried.stepRuns).toHaveLength(2)
          expect(retried.stepRuns[0]!.status).toBe("interrupted")
          expect(retried.stepRuns[1]!.status).toBe("queued")
        }),
      ))

    it("rejects retry for Queued, Running, terminal, and never-failed Work Items", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const sql = yield* SqlClient.SqlClient
          const { repository, issue } = yield* seedActionableIssue

          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )

          const queuedError = yield* Effect.flip(lifecycle.retry(created.id))
          expect(queuedError).toBeInstanceOf(ActiveStepRunExistsError)
          if (queuedError instanceof ActiveStepRunExistsError) {
            expect(queuedError.status).toBe("queued")
            expect(queuedError.workItemId).toBe(created.id)
          }

          const started = yield* lifecycle.runStep(created.stepRuns[0]!.id)
          expect(started._tag).toBe("processed")

          const neverFailed = yield* lifecycle.getWorkItem(created.id)
          expect(neverFailed.state).toBe("install_dependencies")
          const neverFailedError = yield* Effect.flip(
            lifecycle.retry(neverFailed.id),
          )
          expect(neverFailedError).toBeInstanceOf(ActiveStepRunExistsError)

          // Clear the next queued run and leave only a Succeeded prior run for create_worktree
          // so retry on install_dependencies has no failed latest attempt.
          const installQueued = neverFailed.stepRuns.find(
            (run) =>
              run.step === "install_dependencies" && run.status === "queued",
          )!
          yield* sql.unsafe(
            `UPDATE step_run
             SET status = 'cancelled', finished_at = ?, updated_at = ?
             WHERE id = ?`,
            [Date.now(), Date.now(), installQueued.id],
          )

          const notEligible = yield* Effect.flip(
            lifecycle.retry(neverFailed.id),
          )
          expect(notEligible).toBeInstanceOf(RetryNotEligibleError)

          // Running rejection
          const { repository: repo2, issue: issue2 } = yield* Effect.gen(
            function* () {
              const db = yield* DbService
              const repository = yield* db.addRepository({
                ...sampleRepository,
                githubRepo: "widgets-running",
                localPath: "/repos/acme/widgets-running.git",
              })
              const issue = yield* db.storeIssue({
                repositoryId: repository.id,
                githubIssueNumber: 43,
                ...sampleIssueFields,
                url: "https://github.com/acme/widgets/issues/43",
              })
              return { repository, issue }
            },
          )
          const runningItem = yield* lifecycle.implementNow(
            repo2.id,
            issue2.githubIssueNumber,
          )
          yield* sql.unsafe(
            `UPDATE step_run
             SET status = 'running', started_at = ?, updated_at = ?
             WHERE id = ?`,
            [Date.now(), Date.now(), runningItem.stepRuns[0]!.id],
          )
          const runningError = yield* Effect.flip(
            lifecycle.retry(runningItem.id),
          )
          expect(runningError).toBeInstanceOf(ActiveStepRunExistsError)
          if (runningError instanceof ActiveStepRunExistsError) {
            expect(runningError.status).toBe("running")
          }

          // Terminal rejection
          yield* sql.unsafe(
            `UPDATE work_item SET state = 'complete', updated_at = ? WHERE id = ?`,
            [Date.now(), created.id],
          )
          const terminalError = yield* Effect.flip(lifecycle.retry(created.id))
          expect(terminalError).toBeInstanceOf(WorkItemTerminalError)
          if (terminalError instanceof WorkItemTerminalError) {
            expect(terminalError.state).toBe("complete")
          }
        }),
      ))

    it("cannot create more than one active Step Run under concurrent Retry", () => {
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        createWorktree: () =>
          Effect.fail(new Error("fail for concurrent retry")),
      }

      return runWithSteps(
        steps,
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const { repository, issue } = yield* seedActionableIssue

          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          yield* claimAndRunPending

          const results = yield* Effect.all(
            [
              lifecycle.retry(created.id).pipe(Effect.result),
              lifecycle.retry(created.id).pipe(Effect.result),
            ],
            { concurrency: "unbounded" },
          )

          const successes = results.filter((result) => Result.isSuccess(result))
          const failures = results.filter((result) => Result.isFailure(result))
          expect(successes).toHaveLength(1)
          expect(failures).toHaveLength(1)
          if (Result.isFailure(failures[0]!)) {
            expect(failures[0].failure).toBeInstanceOf(ActiveStepRunExistsError)
          }

          const final = yield* lifecycle.getWorkItem(created.id)
          expect(final.state).toBe("create_worktree")
          const active = final.stepRuns.filter(
            (run) => run.status === "queued" || run.status === "running",
          )
          expect(active).toHaveLength(1)
          expect(
            final.stepRuns.filter((run) => run.status === "failed"),
          ).toHaveLength(1)
        }),
      )
    })
  })

  describe("delivery safety and interruption", () => {
    it("acknowledges a stale delivery without invoking a handler", () => {
      let createCalls = 0
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        createWorktree: () => {
          createCalls += 1
          return Effect.succeed("/tmp/worktrees/stale-delivery")
        },
      }

      return runWithSteps(
        steps,
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const queue = yield* QueueService
          const { repository, issue } = yield* seedActionableIssue

          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          const stepRunId = created.stepRuns[0]!.id
          const jobId = created.stepRuns[0]!.queueJobId!

          const first = yield* lifecycle.runStep(stepRunId)
          expect(first._tag).toBe("processed")
          expect(createCalls).toBe(1)

          const second = yield* lifecycle.runStep(stepRunId)
          expect(second).toEqual({ _tag: "noop" })
          expect(createCalls).toBe(1)

          const remaining = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
          expect(Option.isSome(remaining)).toBe(true)
          if (Option.isSome(remaining)) {
            expect(remaining.value.jobId).not.toBe(jobId)
          }

          const final = yield* lifecycle.getWorkItem(created.id)
          expect(final.state).toBe("install_dependencies")
          expect(
            final.stepRuns.filter((run) => run.step === "create_worktree"),
          ).toHaveLength(1)
        }),
      )
    })

    it("marks a Running Step Run Interrupted on lease-expiry redelivery without rerunning the handler", () => {
      let createCalls = 0
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        createWorktree: () => {
          createCalls += 1
          return Effect.succeed("/tmp/worktrees/should-not-rerun")
        },
      }

      return runWithSteps(
        steps,
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const queue = yield* QueueService
          const sql = yield* SqlClient.SqlClient
          const { repository, issue } = yield* seedActionableIssue

          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          const stepRunId = created.stepRuns[0]!.id
          const jobId = created.stepRuns[0]!.queueJobId!
          const now = Date.now()
          const startedAt =
            now -
            Duration.toMillis(lifecycle.maxDurations.create_worktree) -
            1_000

          yield* sql.unsafe(
            `UPDATE step_run
             SET status = 'running', started_at = ?, updated_at = ?
             WHERE id = ?`,
            [startedAt, now, stepRunId],
          )
          yield* sql.unsafe(
            `UPDATE job_queue
             SET locked_until = ?, updated_at = ?
             WHERE id = ?`,
            [now - 1, now, jobId],
          )

          const claimed = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
          expect(Option.isSome(claimed)).toBe(true)
          if (Option.isNone(claimed)) {
            return yield* Effect.die("expected redelivered lifecycle job")
          }
          expect(claimed.value.jobId).toBe(jobId)

          const result = yield* lifecycle.runStep(stepRunId)
          expect(result._tag).toBe("noop")
          expect(createCalls).toBe(0)

          const final = yield* lifecycle.getWorkItem(created.id)
          expect(final.state).toBe("create_worktree")
          const run = final.stepRuns[0]!
          expect(run.status).toBe("interrupted")
          expect(run.reasonCode).toBe(STEP_RUN_REASON.interrupted)
          expect(run.reasonMessage).toBeTruthy()
          expect(run.startedAt).toBeInstanceOf(Date)
          expect(run.finishedAt).toBeInstanceOf(Date)

          const remaining = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
          expect(Option.isNone(remaining)).toBe(true)

          const retried = yield* lifecycle.retry(created.id)
          expect(retried.stepRuns).toHaveLength(2)
          expect(retried.stepRuns[0]!.status).toBe("interrupted")
          expect(retried.stepRuns[1]!.status).toBe("queued")
        }),
      )
    })

    it("records Interrupted when the handler is fiber-interrupted before an outcome is established", () => {
      const hangForever: LifecycleStepsShape = {
        ...successfulSteps,
        createWorktree: () =>
          Effect.gen(function* () {
            yield* Effect.sleep("10 seconds")
            return "/tmp/worktrees/never"
          }),
      }

      return runWithSteps(
        hangForever,
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const queue = yield* QueueService
          const { repository, issue } = yield* seedActionableIssue

          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          const stepRunId = created.stepRuns[0]!.id

          const fiber = yield* Effect.forkChild(lifecycle.runStep(stepRunId))
          yield* Effect.sleep("30 millis")
          yield* Fiber.interrupt(fiber)

          const final = yield* lifecycle.getWorkItem(created.id)
          expect(final.state).toBe("create_worktree")
          const run = final.stepRuns[0]!
          expect(run.status).toBe("interrupted")
          expect(run.reasonCode).toBe(STEP_RUN_REASON.interrupted)
          expect(run.finishedAt).toBeInstanceOf(Date)

          const remaining = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
          expect(Option.isNone(remaining)).toBe(true)

          const retried = yield* lifecycle.retry(created.id)
          expect(retried.stepRuns[1]!.status).toBe("queued")
        }),
      )
    })
  })

  describe("abandon", () => {
    it("abandons a Queued Work Item, cancels the Step Run, and removes its queue job", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const queue = yield* QueueService
          const { repository, issue } = yield* seedActionableIssue

          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )

          const abandoned = yield* lifecycle.abandon(created.id)
          expect(abandoned.state).toBe("abandoned")
          expect(abandoned.stepRuns).toHaveLength(1)
          const run = abandoned.stepRuns[0]!
          expect(run.status).toBe("cancelled")
          expect(run.startedAt).toBeNull()
          expect(run.finishedAt).toBeInstanceOf(Date)
          expect(run.reasonCode).toBe(STEP_RUN_REASON.abandoned)
          expect(run.reasonMessage).toBeTruthy()

          const remaining = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
          expect(Option.isNone(remaining)).toBe(true)

          const late = yield* lifecycle.runStep(run.id)
          expect(late).toEqual({ _tag: "noop" })

          const next = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          expect(next.id).not.toBe(created.id)
          expect(next.state).toBe("create_worktree")

          const listed = yield* lifecycle.listWorkItemsForIssue(
            repository.id,
            issue.githubIssueNumber,
          )
          expect(listed.map((item) => item.id)).toEqual([created.id, next.id])
          expect(listed[0]!.state).toBe("abandoned")
        }),
      ))

    it("abandons after Failed or Interrupted runs while preserving Step Run history", () => {
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        createWorktree: () => Effect.fail(new Error("fail then abandon")),
      }

      return runWithSteps(
        steps,
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const queue = yield* QueueService
          const sql = yield* SqlClient.SqlClient
          const { repository, issue } = yield* seedActionableIssue

          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          const job = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
          expect(Option.isSome(job)).toBe(true)
          if (Option.isNone(job)) {
            return yield* Effect.die("expected job")
          }
          yield* lifecycle.runStep(
            (job.value.payload as { stepRunId: string }).stepRunId,
          )

          const afterFail = yield* lifecycle.getWorkItem(created.id)
          expect(afterFail.stepRuns[0]!.status).toBe("failed")

          const abandoned = yield* lifecycle.abandon(created.id)
          expect(abandoned.state).toBe("abandoned")
          expect(abandoned.stepRuns).toHaveLength(1)
          expect(abandoned.stepRuns[0]!.status).toBe("failed")
          expect(abandoned.stepRuns[0]!.reasonMessage).toContain(
            "fail then abandon",
          )

          const second = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          const now = Date.now()
          yield* sql.unsafe(
            `UPDATE step_run
             SET status = 'interrupted',
                 started_at = ?,
                 finished_at = ?,
                 reason_code = ?,
                 reason_message = 'worker lost',
                 updated_at = ?
             WHERE id = ?`,
            [
              now,
              now,
              STEP_RUN_REASON.interrupted,
              now,
              second.stepRuns[0]!.id,
            ],
          )
          if (second.stepRuns[0]!.queueJobId) {
            yield* queue
              .acknowledge(second.stepRuns[0]!.queueJobId)
              .pipe(Effect.catch(() => Effect.void))
          }

          const abandonedInterrupted = yield* lifecycle.abandon(second.id)
          expect(abandonedInterrupted.state).toBe("abandoned")
          expect(abandonedInterrupted.stepRuns[0]!.status).toBe("interrupted")

          const third = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          expect(third.id).not.toBe(created.id)
          expect(third.id).not.toBe(second.id)

          const listed = yield* lifecycle.listWorkItemsForIssue(
            repository.id,
            issue.githubIssueNumber,
          )
          expect(listed).toHaveLength(3)
          expect(listed.map((item) => item.state)).toEqual([
            "abandoned",
            "abandoned",
            "create_worktree",
          ])
        }),
      )
    })

    it("rejects abandon for terminal Work Items and while a Step Run is Running", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const sql = yield* SqlClient.SqlClient
          const { repository, issue } = yield* seedActionableIssue

          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )

          yield* sql.unsafe(
            `UPDATE step_run
             SET status = 'running', started_at = ?, updated_at = ?
             WHERE id = ?`,
            [Date.now(), Date.now(), created.stepRuns[0]!.id],
          )

          const runningError = yield* Effect.flip(lifecycle.abandon(created.id))
          expect(runningError).toBeInstanceOf(WorkItemHasRunningStepError)
          if (runningError instanceof WorkItemHasRunningStepError) {
            expect(runningError.workItemId).toBe(created.id)
            expect(runningError.stepRunId).toBe(created.stepRuns[0]!.id)
          }

          yield* sql.unsafe(
            `UPDATE step_run
             SET status = 'failed', finished_at = ?, updated_at = ?
             WHERE id = ?`,
            [Date.now(), Date.now(), created.stepRuns[0]!.id],
          )
          const abandoned = yield* lifecycle.abandon(created.id)
          expect(abandoned.state).toBe("abandoned")

          const terminalError = yield* Effect.flip(
            lifecycle.abandon(created.id),
          )
          expect(terminalError).toBeInstanceOf(WorkItemTerminalError)
          if (terminalError instanceof WorkItemTerminalError) {
            expect(terminalError.state).toBe("abandoned")
          }

          yield* sql.unsafe(
            `UPDATE work_item SET state = 'complete', updated_at = ? WHERE id = ?`,
            [Date.now(), created.id],
          )
          const completeError = yield* Effect.flip(
            lifecycle.abandon(created.id),
          )
          expect(completeError).toBeInstanceOf(WorkItemTerminalError)
        }),
      ))

    it("cannot abandon while a concurrently started handler is Running", async () => {
      const started = await Effect.runPromise(Deferred.make<void>())
      const release = await Effect.runPromise(Deferred.make<void>())
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        createWorktree: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as("/tmp/worktrees/concurrent-abandon"),
          ),
      }

      return runWithSteps(
        steps,
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const { repository, issue } = yield* seedActionableIssue
          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )

          const running = yield* Effect.forkChild(
            lifecycle.runStep(created.stepRuns[0]!.id),
          )
          yield* Deferred.await(started)

          const error = yield* Effect.flip(lifecycle.abandon(created.id))
          expect(error).toBeInstanceOf(WorkItemHasRunningStepError)
          expect((yield* lifecycle.getWorkItem(created.id)).state).toBe(
            "create_worktree",
          )

          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(running)
        }),
      )
    })
  })
})
