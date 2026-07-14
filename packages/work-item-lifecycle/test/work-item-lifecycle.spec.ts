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
  const TestLayer = WorkItemLifecycleLive.pipe(
    Layer.provideMerge(DbServiceLive),
    Layer.provideMerge(SqliteQueueServiceLive),
    Layer.provideMerge(DatabaseTest),
  )

  type TestRequirements = Layer.Layer.Success<typeof TestLayer>

  const runTest = <A, E>(
    test: Effect.Effect<A, E, TestRequirements>,
  ): Promise<A> => Effect.runPromise(Effect.provide(test, TestLayer))

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
})
