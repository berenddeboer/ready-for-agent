import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Result,
  Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { SqlClient } from "effect/unstable/sql"
import { DatabaseTest, makeFileDatabaseTest } from "@ready-for-agent/db/test"
import {
  DbService,
  DbServiceLive,
  RepositoryHasRunningStepError,
} from "@ready-for-agent/db-service"
import {
  EnqueueError,
  type JobId,
  QueueService,
} from "@ready-for-agent/queue-service"
import { stubQueueService } from "@ready-for-agent/queue-service/test"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
  ActiveStepRunExistsError,
  BuildModelNotConfiguredError,
  CHECK_START_DEADLINE_MS,
  CloseIssueEligibilityError,
  CommitOpenCodeError,
  CreatePrOpenCodeError,
  IssueBlockedError,
  IssueNotFoundError,
  IssueNotOpenError,
  type LifecycleStepContext,
  LifecycleStepFailedError,
  LifecycleSteps,
  type LifecycleStepsShape,
  NonTransactionalQueueError,
  ParentIssueError,
  PrStatusChecksUnresolvedError,
  PreCommitHookFailedError,
  REVIEW_FIX_LIMIT_REASON,
  ResetCleanupError,
  RetryNotEligibleError,
  STEP_RUN_REASON,
  UnfinishedWorkItemExistsError,
  WORK_ITEM_LIFECYCLE_QUEUE,
  WorkItemHasRunningStepError,
  WorkItemLifecycle,
  WorkItemLifecycleLive,
  WorkItemNotFoundError,
  WorkItemTerminalError,
  filterWorkItemsByListKind,
  isTerminalWorkItemState,
  makeWorkItemLifecycleLive,
  stubActiveAgentBackendLayer,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("WorkItemLifecycle", () => {
  const settledTiming = {
    createdAt: new Date(0),
    headSha: "settled-head",
    headPushedAt: new Date(0),
    isDraft: false,
  } as const

  const watchResult = <
    T extends
      | "succeeded"
      | "pending"
      | "expected"
      | "no_checks"
      | "failed"
      | "closed"
      | "handoff_needed",
  >(
    tag: T,
  ) =>
    ({
      _tag: tag,
      ...settledTiming,
    }) as const

  const successfulSteps: LifecycleStepsShape = {
    createWorktree: () =>
      Effect.succeed({
        worktreePath: "/tmp/worktrees/acme-widgets-42",
        startingCommitOid: "abc123",
      }),
    installDependencies: () => Effect.void,
    implement: () => Effect.succeed("ses_test_implement_session"),
    assessChanges: () => Effect.succeed({ _tag: "changes" }),
    preCommit: () => Effect.void,
    review: () => Effect.succeed({ _tag: "clean" as const }),
    commit: () => Effect.void,
    createPr: () => Effect.succeed(101),
    watchPrStatusChecks: () => Effect.succeed(watchResult("succeeded")),
    resolvePrMergeConflict: () => Effect.succeed({ _tag: "processed" }),
    investigatePrStatusChecks: () =>
      Effect.succeed({ _tag: "processed", handledCheckIds: [] }),
    markPrReadyForReview: () => Effect.void,
    decidePrMerge: () => Effect.succeed({ _tag: "clanker_merge" }),
    mergePr: () => Effect.succeed({ _tag: "merged" }),
    closeIssue: () => Effect.void,
    localCleanup: () => Effect.void,
    removeWorktree: () => Effect.void,
  }

  const SuccessfulStepsLive = Layer.succeed(
    LifecycleSteps,
    LifecycleSteps.of(successfulSteps),
  )

  const TestLayer = WorkItemLifecycleLive.pipe(
    Layer.provideMerge(stubActiveAgentBackendLayer()),
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
      Layer.provideMerge(stubActiveAgentBackendLayer()),
      Layer.provideMerge(
        Layer.succeed(LifecycleSteps, LifecycleSteps.of(steps)),
      ),
      Layer.provideMerge(DbServiceLive),
      Layer.provideMerge(SqliteQueueServiceLive),
      Layer.provideMerge(DatabaseTest),
    )

  const makeRestartTestLayer = (steps: LifecycleStepsShape, filename: string) =>
    WorkItemLifecycleLive.pipe(
      Layer.provideMerge(stubActiveAgentBackendLayer()),
      Layer.provideMerge(
        Layer.succeed(LifecycleSteps, LifecycleSteps.of(steps)),
      ),
      Layer.provideMerge(DbServiceLive),
      Layer.provideMerge(SqliteQueueServiceLive),
      Layer.provideMerge(makeFileDatabaseTest(filename)),
      Layer.provideMerge(TestClock.layer()),
    )

  const runWithSteps = <A, E>(
    steps: LifecycleStepsShape,
    test: Effect.Effect<A, E, TestRequirements>,
  ): Promise<A> => Effect.runPromise(Effect.provide(test, makeTestLayer(steps)))

  const runWithTestClock = <A, E>(
    test: Effect.Effect<A, E, TestRequirements | TestClock.TestClock>,
  ): Promise<A> =>
    Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          test,
          TestLayer.pipe(Layer.provideMerge(TestClock.layer())),
        ),
      ),
    )

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
    issueAuthor: null,
    parent: null,
    parentPosition: null,
    hasChildren: false,
    blockedBy: [],
  }

  const seedHarnessBuildModel = Effect.gen(function* () {
    const db = yield* DbService
    const config = yield* db.getConfig
    if (config.defaultModel !== null && config.defaultThinkingLevel !== null) {
      return
    }
    yield* db.updateConfig({
      selectedAgentBackend: "opencode",
      defaultModel: config.defaultModel ?? "opencode/deepseek-v4-flash-free",
      defaultThinkingLevel: config.defaultThinkingLevel ?? "low",
      reviewModel: config.reviewModel,
      reviewThinkingLevel: config.reviewThinkingLevel,
      maxConcurrentAgentTurns: config.maxConcurrentAgentTurns,
      maxConcurrentWorkItems: config.maxConcurrentWorkItems,
    })
  })

  const seedActionableIssue = Effect.gen(function* () {
    const db = yield* DbService
    yield* seedHarnessBuildModel
    const repository = yield* db.addRepository(sampleRepository)
    const issue = yield* db.storeIssue({
      repositoryId: repository.id,
      githubIssueNumber: 42,
      ...sampleIssueFields,
    })
    return { repository, issue }
  })

  /** Drop Create PR draft provenance so already-ready stubs use Last PR Change. */
  const forgetCreatePrDraftProvenance = (workItemId: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe(
        `UPDATE work_item
         SET check_start_last_observed_is_draft = NULL
         WHERE id = ?`,
        [workItemId],
      )
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
          expect(workItem.issueTitle).toBe(sampleIssueFields.title)
          expect(workItem.state).toBe("create_worktree")
          expect(workItem.paused).toBe(false)
          expect(workItem.pauseBeforeStep).toBeNull()
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

          yield* db.deleteIssue(repository.id, issue.githubIssueNumber)
          const reloaded = yield* lifecycle.getWorkItem(workItem.id)
          expect(reloaded.issueTitle).toBe(sampleIssueFields.title)
        }),
      ))

    it("rejects when no build model can be resolved", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const db = yield* DbService
          const repository = yield* db.addRepository(sampleRepository)
          const issue = yield* db.storeIssue({
            repositoryId: repository.id,
            githubIssueNumber: 42,
            ...sampleIssueFields,
          })

          const error = yield* Effect.flip(
            lifecycle.implementNow(repository.id, issue.githubIssueNumber),
          )

          expect(error).toBeInstanceOf(BuildModelNotConfiguredError)
          if (error instanceof BuildModelNotConfiguredError) {
            expect(error.message).toBe("Select a default build model first")
          }
        }),
      ))

    it("allows repository build override when harness defaults are unset", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const db = yield* DbService
          const repository = yield* db.addRepository(sampleRepository)
          const issue = yield* db.storeIssue({
            repositoryId: repository.id,
            githubIssueNumber: 42,
            ...sampleIssueFields,
          })
          yield* db.updateRepositorySettings({
            repositoryId: repository.id,
            paused: repository.paused,
            defaultModel: "anthropic/claude-sonnet-4-5",
            defaultThinkingLevel: "max",
            reviewModel: null,
            reviewThinkingLevel: null,
            autoMerge: repository.autoMerge,
            includeAllIssueAuthors: repository.includeAllIssueAuthors,
          })

          const workItem = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )

          expect(workItem.state).toBe("create_worktree")
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
      const failingEnqueueQueue = stubQueueService({
        enqueue: () => {
          enqueueCalls += 1
          return Effect.fail(
            new EnqueueError({
              queue: WORK_ITEM_LIFECYCLE_QUEUE,
              message: "injected enqueue failure",
            }),
          )
        },
      })

      const layer = WorkItemLifecycleLive.pipe(
        Layer.provideMerge(stubActiveAgentBackendLayer()),
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
          yield* seedHarnessBuildModel
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

  describe("implementLocally", () => {
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

    it("creates a Work Item that pauses before Commit", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const { repository, issue } = yield* seedActionableIssue

          const workItem = yield* lifecycle.implementLocally(
            repository.id,
            issue.githubIssueNumber,
          )

          expect(workItem.state).toBe("create_worktree")
          expect(workItem.paused).toBe(false)
          expect(workItem.pauseBeforeStep).toBe("commit")
          expect(workItem.stepRuns).toHaveLength(1)
          expect(workItem.stepRuns[0]!.status).toBe("queued")
        }),
      ))

    it("runs local steps through Review then pauses at Commit without enqueueing", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const queue = yield* QueueService
          const { repository, issue } = yield* seedActionableIssue

          const created = yield* lifecycle.implementLocally(
            repository.id,
            issue.githubIssueNumber,
          )

          // create_worktree → install → implement → assess_changes → pre_commit → review
          for (const expectedNext of [
            "install_dependencies",
            "implement",
            "assess_changes",
            "pre_commit",
            "review",
            "commit",
          ] as const) {
            const result = yield* claimAndRunPending
            expect(result._tag).toBe("processed")
            if (result._tag === "processed") {
              expect(result.workItem.state).toBe(expectedNext)
              if (expectedNext === "commit") {
                expect(result.workItem.paused).toBe(true)
                expect(result.workItem.pauseBeforeStep).toBe("commit")
                expect(
                  result.workItem.stepRuns.every(
                    (run) => run.status !== "queued",
                  ),
                ).toBe(true)
              } else {
                expect(result.workItem.paused).toBe(false)
              }
            }
          }

          const remaining = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
          expect(Option.isNone(remaining)).toBe(true)

          const started = yield* lifecycle.start(created.id)
          expect(started.paused).toBe(false)
          expect(started.state).toBe("commit")
          expect(started.stepRuns.at(-1)).toMatchObject({
            step: "commit",
            status: "queued",
          })
        }),
      ))
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

    it("lists Complete, Failed, and Abandoned attempts in creation order", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const queue = yield* QueueService
          const db = yield* DbService
          const { repository, issue } = yield* seedActionableIssue

          const claimAndRun = Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
            const job = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
            expect(Option.isSome(job)).toBe(true)
            if (Option.isNone(job)) {
              return yield* Effect.die("expected job")
            }
            return yield* lifecycle.runStep(
              (job.value.payload as { stepRunId: string }).stepRunId,
            )
          })

          const complete = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          for (let i = 0; i < 8; i++) {
            yield* claimAndRun
          }
          yield* forgetCreatePrDraftProvenance(complete.id)
          for (let i = 0; i < 4; i++) {
            yield* claimAndRun
          }
          expect((yield* lifecycle.getWorkItem(complete.id)).state).toBe(
            "complete",
          )

          const failed = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          yield* db.deleteIssue(repository.id, issue.githubIssueNumber)
          const failJob = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
          if (Option.isNone(failJob)) {
            return yield* Effect.die("expected job")
          }
          yield* lifecycle.runStep(
            (failJob.value.payload as { stepRunId: string }).stepRunId,
          )
          expect((yield* lifecycle.getWorkItem(failed.id)).state).toBe("failed")

          yield* db.storeIssue({
            repositoryId: repository.id,
            githubIssueNumber: issue.githubIssueNumber,
            ...sampleIssueFields,
          })

          const abandonedQueued = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          yield* lifecycle.abandon(abandonedQueued.id)

          const listed = yield* lifecycle.listWorkItemsForIssue(
            repository.id,
            issue.githubIssueNumber,
          )
          expect(listed.map((item) => item.state)).toEqual([
            "complete",
            "failed",
            "abandoned",
          ])
          expect(listed.map((item) => item.id)).toEqual([
            complete.id,
            failed.id,
            abandonedQueued.id,
          ])
        }),
      ))

    it("allows Implement Now after terminal Complete and Failed attempts", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const queue = yield* QueueService
          const { repository, issue } = yield* seedActionableIssue

          const first = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          for (let i = 0; i < 8; i++) {
            const sql = yield* SqlClient.SqlClient
            yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
            const job = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
            expect(Option.isSome(job)).toBe(true)
            if (Option.isNone(job)) {
              return yield* Effect.die("expected job")
            }
            yield* lifecycle.runStep(
              (job.value.payload as { stepRunId: string }).stepRunId,
            )
          }
          yield* forgetCreatePrDraftProvenance(first.id)
          for (let i = 0; i < 4; i++) {
            const sql = yield* SqlClient.SqlClient
            yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
            const job = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
            expect(Option.isSome(job)).toBe(true)
            if (Option.isNone(job)) {
              return yield* Effect.die("expected job")
            }
            yield* lifecycle.runStep(
              (job.value.payload as { stepRunId: string }).stepRunId,
            )
          }
          expect((yield* lifecycle.getWorkItem(first.id)).state).toBe(
            "complete",
          )

          const second = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          expect(second.id).not.toBe(first.id)
          expect(second.state).toBe("create_worktree")

          const unfinishedBlocks = yield* Effect.flip(
            lifecycle.implementNow(repository.id, issue.githubIssueNumber),
          )
          expect(unfinishedBlocks).toBeInstanceOf(UnfinishedWorkItemExistsError)
        }),
      ))

    it("derives queue wait, execution duration, and state residence from timestamps", () =>
      runWithTestClock(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const queue = yield* QueueService
          const { repository, issue } = yield* seedActionableIssue

          yield* TestClock.setTime(1_000)
          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )

          yield* TestClock.setTime(4_000)
          const queuedOnly = yield* lifecycle.getWorkItem(created.id)
          expect(queuedOnly.stepRuns[0]!.queueWaitMs).toBe(3_000)
          expect(queuedOnly.stepRuns[0]!.executionDurationMs).toBeNull()
          expect(queuedOnly.stateResidenceMs).toBe(3_000)

          const job = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
          expect(Option.isSome(job)).toBe(true)
          if (Option.isNone(job)) {
            return yield* Effect.die("expected job")
          }

          yield* TestClock.setTime(6_000)
          const afterSuccess = yield* lifecycle.runStep(
            (job.value.payload as { stepRunId: string }).stepRunId,
          )
          expect(afterSuccess._tag).toBe("processed")
          if (afterSuccess._tag !== "processed") {
            return
          }

          const createRun = afterSuccess.workItem.stepRuns[0]!
          expect(createRun.status).toBe("succeeded")
          expect(createRun.queueWaitMs).toBe(5_000)
          expect(createRun.executionDurationMs).toBe(0)

          const installQueued = afterSuccess.workItem.stepRuns[1]!
          expect(installQueued.status).toBe("queued")
          expect(installQueued.queueWaitMs).toBe(0)
          expect(afterSuccess.workItem.stateResidenceMs).toBe(0)

          yield* TestClock.setTime(9_000)
          const afterAbandon = yield* lifecycle.abandon(created.id)
          const cancelled = afterAbandon.stepRuns.find(
            (run) => run.status === "cancelled",
          )!
          expect(cancelled.queueWaitMs).toBe(3_000)
          expect(cancelled.executionDurationMs).toBeNull()
          expect(afterAbandon.stateResidenceMs).toBe(0)
        }),
      ))

    it("derives timings across retries, interruption, and currently running work", async () => {
      const failingSteps: LifecycleStepsShape = {
        ...successfulSteps,
        createWorktree: () =>
          Effect.fail(
            new LifecycleStepFailedError({ message: "first attempt" }),
          ),
      }

      return Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              const lifecycle = yield* WorkItemLifecycle
              const queue = yield* QueueService
              const sql = yield* SqlClient.SqlClient
              const { repository, issue } = yield* seedActionableIssue

              yield* TestClock.setTime(10_000)
              const created = yield* lifecycle.implementNow(
                repository.id,
                issue.githubIssueNumber,
              )

              yield* TestClock.setTime(12_000)
              const job = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
              if (Option.isNone(job)) {
                return yield* Effect.die("expected job")
              }
              yield* lifecycle.runStep(
                (job.value.payload as { stepRunId: string }).stepRunId,
              )

              const afterFail = yield* lifecycle.getWorkItem(created.id)
              expect(afterFail.stepRuns[0]!.status).toBe("failed")
              expect(afterFail.stepRuns[0]!.queueWaitMs).toBe(2_000)
              expect(afterFail.stepRuns[0]!.executionDurationMs).toBe(0)

              yield* TestClock.setTime(15_000)
              const retried = yield* lifecycle.retry(created.id)
              expect(retried.stepRuns).toHaveLength(2)
              expect(retried.stepRuns[1]!.status).toBe("queued")
              expect(retried.stepRuns[1]!.queueWaitMs).toBe(0)

              yield* TestClock.setTime(18_000)
              const afterQueueWait = yield* lifecycle.getWorkItem(created.id)
              expect(afterQueueWait.stepRuns[1]!.queueWaitMs).toBe(3_000)

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
                  16_000,
                  17_000,
                  STEP_RUN_REASON.interrupted,
                  17_000,
                  afterQueueWait.stepRuns[1]!.id,
                ],
              )
              if (afterQueueWait.stepRuns[1]!.queueJobId) {
                yield* queue
                  .acknowledge(afterQueueWait.stepRuns[1]!.queueJobId)
                  .pipe(Effect.catch(() => Effect.void))
              }

              const interrupted = yield* lifecycle.getWorkItem(created.id)
              expect(interrupted.stepRuns[1]!.queueWaitMs).toBe(1_000)
              expect(interrupted.stepRuns[1]!.executionDurationMs).toBe(1_000)

              yield* TestClock.setTime(20_000)
              const third = yield* lifecycle.retry(created.id)
              yield* sql.unsafe(
                `UPDATE step_run
                 SET status = 'running', started_at = ?, updated_at = ?
                 WHERE id = ?`,
                [21_000, 21_000, third.stepRuns[2]!.id],
              )
              yield* TestClock.setTime(24_000)
              const running = yield* lifecycle.getWorkItem(created.id)
              expect(running.stepRuns[2]!.queueWaitMs).toBe(1_000)
              expect(running.stepRuns[2]!.executionDurationMs).toBe(3_000)
              expect(running.stateResidenceMs).toBe(14_000)
            }),
            makeTestLayer(failingSteps).pipe(
              Layer.provideMerge(TestClock.layer()),
            ),
          ),
        ),
      )
    })
  })

  describe("queue requirements", () => {
    it("rejects construction when QueueService is not transactional", async () => {
      const nonTransactionalQueue = stubQueueService({
        queueInTransaction: false,
      })

      const NonTransactionalQueueLive = Layer.succeed(
        QueueService,
        QueueService.of(nonTransactionalQueue),
      )

      const layer = WorkItemLifecycleLive.pipe(
        Layer.provideMerge(stubActiveAgentBackendLayer()),
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

    const makeQueuedJobsAvailable = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
    })

    /** Run steps through Create PR, then clear draft provenance for already-ready snapshots. */
    const driveThroughCreatePrAlreadyReady = (workItemId: string) =>
      Effect.gen(function* () {
        for (let index = 0; index < 8; index += 1) {
          yield* makeQueuedJobsAvailable
          yield* claimAndRunPending
        }
        yield* forgetCreatePrDraftProvenance(workItemId)
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
            expect(afterCreate.workItem.startingCommitOid).toBe("abc123")
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
            expect(afterImplement.workItem.state).toBe("assess_changes")
            expect(afterImplement.workItem.sessionId).toBe(
              "ses_test_implement_session",
            )
            expect(afterImplement.workItem.startingCommitOid).toBe("abc123")
          }

          const afterAssess = yield* claimAndRunPending
          expect(afterAssess._tag).toBe("processed")
          if (afterAssess._tag === "processed") {
            expect(afterAssess.workItem.state).toBe("pre_commit")
            expect(afterAssess.workItem.sessionId).toBe(
              "ses_test_implement_session",
            )
            expect(afterAssess.workItem.startingCommitOid).toBe("abc123")
          }

          const afterPreCommit = yield* claimAndRunPending
          expect(afterPreCommit._tag).toBe("processed")
          if (afterPreCommit._tag === "processed") {
            expect(afterPreCommit.workItem.state).toBe("review")
            expect(afterPreCommit.workItem.sessionId).toBe(
              "ses_test_implement_session",
            )
          }

          const afterReview = yield* claimAndRunPending
          expect(afterReview._tag).toBe("processed")
          if (afterReview._tag === "processed") {
            expect(afterReview.workItem.state).toBe("commit")
            expect(afterReview.workItem.sessionId).toBe(
              "ses_test_implement_session",
            )
          }

          const afterCommit = yield* claimAndRunPending
          expect(afterCommit._tag).toBe("processed")
          if (afterCommit._tag === "processed") {
            expect(afterCommit.workItem.state).toBe("create_pr")
            expect(afterCommit.workItem.sessionId).toBe(
              "ses_test_implement_session",
            )
          }

          const afterCreatePr = yield* claimAndRunPending
          expect(afterCreatePr._tag).toBe("processed")
          if (afterCreatePr._tag === "processed") {
            expect(afterCreatePr.workItem.state).toBe("watch_pr_status_checks")
            expect(afterCreatePr.workItem.githubPullRequestNumber).toBe(101)
            const db = yield* DbService
            expect(yield* db.listWorkItemPullRequests(repository.id)).toEqual([
              {
                githubIssueNumber: issue.githubIssueNumber,
                githubPullRequestNumber: 101,
              },
            ])
          }
          yield* forgetCreatePrDraftProvenance(created.id)

          // Already-ready settled PR past its Check-Start Deadline advances to Decide.
          const afterChecks = yield* claimAndRunPending
          expect(afterChecks._tag).toBe("processed")
          if (afterChecks._tag === "processed") {
            expect(afterChecks.workItem.state).toBe("decide_pr_merge")
          }

          const afterDecide = yield* claimAndRunPending
          expect(afterDecide._tag).toBe("processed")
          if (afterDecide._tag === "processed") {
            expect(afterDecide.workItem.state).toBe("merge_pr")
          }

          const afterMerge = yield* claimAndRunPending
          expect(afterMerge._tag).toBe("processed")
          if (afterMerge._tag === "processed") {
            expect(afterMerge.workItem.state).toBe("local_cleanup")
            expect(afterMerge.workItem.worktreePath).toBe(
              "/tmp/worktrees/acme-widgets-42",
            )
          }

          const afterCleanup = yield* claimAndRunPending
          expect(afterCleanup._tag).toBe("processed")
          if (afterCleanup._tag === "processed") {
            expect(afterCleanup.workItem.state).toBe("complete")
            expect(afterCleanup.workItem.worktreePath).toBeNull()
            expect(afterCleanup.workItem.sessionId).toBe(
              "ses_test_implement_session",
            )
            expect(afterCleanup.workItem.githubPullRequestNumber).toBe(101)
            expect(afterCleanup.workItem.failureCode).toBeNull()
            expect(
              afterCleanup.workItem.stepRuns.map((run) => [
                run.step,
                run.status,
              ]),
            ).toEqual([
              ["create_worktree", "succeeded"],
              ["install_dependencies", "succeeded"],
              ["implement", "succeeded"],
              ["assess_changes", "succeeded"],
              ["pre_commit", "succeeded"],
              ["review", "succeeded"],
              ["commit", "succeeded"],
              ["create_pr", "succeeded"],
              ["watch_pr_status_checks", "succeeded"],
              ["decide_pr_merge", "succeeded"],
              ["merge_pr", "succeeded"],
              ["local_cleanup", "succeeded"],
            ])
          }

          const queue = yield* QueueService
          const remaining = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
          expect(Option.isNone(remaining)).toBe(true)

          const final = yield* lifecycle.getWorkItem(created.id)
          expect(final.state).toBe("complete")
          expect(final.stepRuns).toHaveLength(12)
        }),
      ))

    it("allows three merge revalidations, replays Decide, preserves checks, and hands off the fourth", () => {
      let decideCalls = 0
      let mergeCalls = 0
      let conflictReturned = false
      let resolveCalls = 0
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        watchPrStatusChecks: () => {
          if (mergeCalls === 1 && !conflictReturned) {
            conflictReturned = true
            return Effect.succeed({
              _tag: "conflict",
              retiredCheckIds: [],
              ...settledTiming,
            })
          }
          return Effect.succeed(watchResult("succeeded"))
        },
        resolvePrMergeConflict: () => {
          resolveCalls += 1
          return Effect.succeed({ _tag: "processed" })
        },
        decidePrMerge: () => {
          decideCalls += 1
          return Effect.succeed({ _tag: "clanker_merge" })
        },
        mergePr: () => {
          mergeCalls += 1
          return Effect.succeed({
            _tag: "revalidation",
            reason: "head_changed",
            message: "Pull request head changed while merging",
          })
        },
      }

      return runWithSteps(
        steps,
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const sql = yield* SqlClient.SqlClient
          const { repository, issue } = yield* seedActionableIssue
          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          yield* sql.unsafe(
            `INSERT INTO pr_status_check
               (id, work_item_id, external_id, name, outcome, handled_at, observed_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'green', ?, ?, ?, ?)`,
            [
              "psc-preserved",
              created.id,
              "actions-job:123",
              "test",
              1,
              1,
              1,
              1,
            ],
          )

          // create…create_pr (8) + watch→decide + decide→merge = 10 runs to merge_pr.
          yield* driveThroughCreatePrAlreadyReady(created.id)
          for (let index = 0; index < 2; index += 1) {
            yield* makeQueuedJobsAvailable
            yield* claimAndRunPending
          }

          for (let attempt = 1; attempt <= 4; attempt += 1) {
            yield* makeQueuedJobsAvailable
            const mergeResult = yield* claimAndRunPending
            expect(mergeResult._tag).toBe("processed")
            if (mergeResult._tag !== "processed") continue
            expect(mergeResult.workItem.state).toBe(
              attempt <= 3 ? "watch_pr_status_checks" : "needs_human",
            )
            if (attempt <= 3) {
              for (let replayStep = 0; replayStep < 6; replayStep += 1) {
                if (
                  (yield* lifecycle.getWorkItem(created.id)).state ===
                  "merge_pr"
                ) {
                  break
                }
                yield* makeQueuedJobsAvailable
                yield* claimAndRunPending
              }
              expect((yield* lifecycle.getWorkItem(created.id)).state).toBe(
                "merge_pr",
              )
            }
          }

          const final = yield* lifecycle.getWorkItem(created.id)
          expect(final.state).toBe("needs_human")
          expect(final.failureMessage).toContain("four changed merge attempts")
          expect(decideCalls).toBe(4)
          expect(resolveCalls).toBe(1)
          expect(
            final.stepRuns.filter(
              (run) =>
                run.step === "merge_pr" &&
                run.reasonCode === STEP_RUN_REASON.mergeRevalidation,
            ),
          ).toHaveLength(4)
          const checks = (yield* sql.unsafe(
            `SELECT handled_at FROM pr_status_check
             WHERE work_item_id = ? AND external_id = ?`,
            [created.id, "actions-job:123"],
          )) as readonly { readonly handled_at: number | null }[]
          expect(checks).toEqual([{ handled_at: 1 }])
        }),
      )
    })

    it("enters merge-related Needs Human on an unchanged rejected merge", () => {
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        mergePr: () =>
          Effect.succeed({
            _tag: "needs_human",
            reason: "merge_rejected",
            message: "GitHub rejected the unchanged mergeable pull request",
          }),
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
          yield* driveThroughCreatePrAlreadyReady(created.id)
          for (let index = 0; index < 3; index += 1) {
            yield* makeQueuedJobsAvailable
            yield* claimAndRunPending
          }

          const final = yield* lifecycle.getWorkItem(created.id)
          expect(final.state).toBe("needs_human")
          expect(final.failureMessage).toContain("unchanged mergeable")
          expect(final.stepRuns.at(-1)).toMatchObject({
            step: "merge_pr",
            status: "succeeded",
          })
        }),
      )
    })

    it("keeps operational merge failures retryable", () => {
      let mergeCalls = 0
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        mergePr: () => {
          mergeCalls += 1
          return mergeCalls === 1
            ? Effect.fail(
                new LifecycleStepFailedError({ message: "GitHub unavailable" }),
              )
            : Effect.succeed({ _tag: "merged" })
        },
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
          yield* driveThroughCreatePrAlreadyReady(created.id)
          for (let index = 0; index < 3; index += 1) {
            yield* makeQueuedJobsAvailable
            yield* claimAndRunPending
          }

          const failed = yield* lifecycle.getWorkItem(created.id)
          expect(failed.state).toBe("merge_pr")
          expect(failed.stepRuns.at(-1)?.status).toBe("failed")

          yield* lifecycle.retry(created.id)
          yield* makeQueuedJobsAvailable
          yield* claimAndRunPending
          const retried = yield* lifecycle.getWorkItem(created.id)
          expect(retried.state).toBe("local_cleanup")
          expect(
            retried.stepRuns.filter((run) => run.step === "merge_pr").at(-1)
              ?.status,
          ).toBe("succeeded")
        }),
      )
    })

    it("retains the worktree path when local cleanup fails and clears it after Retry", () => {
      let cleanupAttempts = 0
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        localCleanup: () => {
          cleanupAttempts += 1
          return cleanupAttempts === 1
            ? Effect.fail(
                new LifecycleStepFailedError({ message: "worktree is locked" }),
              )
            : Effect.void
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

          yield* driveThroughCreatePrAlreadyReady(created.id)
          for (let index = 0; index < 3; index += 1) {
            yield* makeQueuedJobsAvailable
            yield* claimAndRunPending
          }

          const failedCleanup = yield* claimAndRunPending
          expect(failedCleanup._tag).toBe("processed")
          if (failedCleanup._tag === "processed") {
            expect(failedCleanup.workItem.state).toBe("local_cleanup")
            expect(failedCleanup.workItem.worktreePath).toBe(
              "/tmp/worktrees/acme-widgets-42",
            )
            expect(failedCleanup.workItem.stepRuns.at(-1)?.status).toBe(
              "failed",
            )
          }

          const retried = yield* lifecycle.retry(created.id)
          expect(retried.state).toBe("local_cleanup")
          yield* db.storeIssue({
            repositoryId: repository.id,
            githubIssueNumber: issue.githubIssueNumber,
            ...sampleIssueFields,
            state: "CLOSED",
          })
          const completed = yield* claimAndRunPending
          expect(completed._tag).toBe("processed")
          if (completed._tag === "processed") {
            expect(completed.workItem.state).toBe("complete")
            expect(completed.workItem.worktreePath).toBeNull()
          }
          expect(cleanupAttempts).toBe(2)
        }),
      )
    })

    it("keeps no_checks pending until the 90s Check-Start Deadline and caps the final poll delay", () => {
      const anchorInstant = 1_008_000
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        watchPrStatusChecks: () =>
          Effect.succeed({
            _tag: "no_checks" as const,
            createdAt: new Date(anchorInstant),
            headSha: "fresh-head",
            headPushedAt: new Date(anchorInstant),
            isDraft: false,
          }),
      }

      return Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              yield* TestClock.setTime(1_000_000)
              const lifecycle = yield* WorkItemLifecycle
              const sql = yield* SqlClient.SqlClient
              const { repository, issue } = yield* seedActionableIssue
              const created = yield* lifecycle.implementNow(
                repository.id,
                issue.githubIssueNumber,
              )

              for (let index = 0; index < 8; index += 1) {
                yield* TestClock.adjust(1_000)
                yield* claimAndRunPending
              }
              yield* forgetCreatePrDraftProvenance(created.id)

              // First Watch poll lands at 1_008_000 after eight 1s steps + 1s.
              yield* TestClock.setTime(anchorInstant)
              const earlyEmpty = yield* claimAndRunPending
              expect(earlyEmpty._tag).toBe("processed")
              if (earlyEmpty._tag === "processed") {
                expect(earlyEmpty.workItem.state).toBe("watch_pr_status_checks")
              }

              const firstDelay = (yield* sql.unsafe(
                `SELECT available_at, created_at FROM job_queue`,
              )) as readonly {
                readonly available_at: number
                readonly created_at: number
              }[]
              expect(firstDelay).toHaveLength(1)
              expect(
                firstDelay[0]!.available_at - firstDelay[0]!.created_at,
              ).toBe(30_000)

              const anchors = (yield* sql.unsafe(
                `SELECT check_start_anchor_at, check_start_anchor_head_sha
                 FROM work_item WHERE id = ?`,
                [created.id],
              )) as readonly {
                readonly check_start_anchor_at: number | null
                readonly check_start_anchor_head_sha: string | null
              }[]
              expect(anchors[0]?.check_start_anchor_head_sha).toBe("fresh-head")
              expect(anchors[0]?.check_start_anchor_at).toBe(anchorInstant)

              // Advance to 89_999 ms after the anchor — still before the deadline.
              yield* TestClock.setTime(anchorInstant + 89_999)
              yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
              const atBoundary = yield* claimAndRunPending
              expect(atBoundary._tag).toBe("processed")
              if (atBoundary._tag === "processed") {
                expect(atBoundary.workItem.state).toBe("watch_pr_status_checks")
              }
              const finalDelay = (yield* sql.unsafe(
                `SELECT available_at, created_at FROM job_queue`,
              )) as readonly {
                readonly available_at: number
                readonly created_at: number
              }[]
              expect(finalDelay).toHaveLength(1)
              expect(
                finalDelay[0]!.available_at - finalDelay[0]!.created_at,
              ).toBe(1)

              // At exactly 90_000 ms after the anchor, settled ready may Decide.
              yield* TestClock.setTime(anchorInstant + CHECK_START_DEADLINE_MS)
              yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
              const afterDeadline = yield* claimAndRunPending
              expect(afterDeadline._tag).toBe("processed")
              if (afterDeadline._tag === "processed") {
                expect(afterDeadline.workItem.state).toBe("decide_pr_merge")
              }
            }),
            makeTestLayer(steps).pipe(Layer.provideMerge(TestClock.layer())),
          ),
        ),
      )
    })

    it("uses first observation of an undated head as the durable Check-Start Anchor fallback", async () => {
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        watchPrStatusChecks: () =>
          Effect.succeed({
            _tag: "no_checks" as const,
            createdAt: new Date(0),
            headSha: "undated-head",
            headPushedAt: null,
            isDraft: false,
          }),
      }

      const root = await mkdtemp(join(tmpdir(), "rfa-check-start-restart-"))
      const dbPath = join(root, "restart.db")
      try {
        const established = await Effect.runPromise(
          Effect.scoped(
            Effect.provide(
              Effect.gen(function* () {
                yield* TestClock.setTime(2_000_000)
                const lifecycle = yield* WorkItemLifecycle
                const sql = yield* SqlClient.SqlClient
                const { repository, issue } = yield* seedActionableIssue
                const created = yield* lifecycle.implementNow(
                  repository.id,
                  issue.githubIssueNumber,
                )

                for (let index = 0; index < 8; index += 1) {
                  yield* TestClock.adjust(1_000)
                  yield* claimAndRunPending
                }
                yield* forgetCreatePrDraftProvenance(created.id)

                yield* TestClock.adjust(1_000)
                const first = yield* claimAndRunPending
                expect(first._tag).toBe("processed")
                if (first._tag === "processed") {
                  expect(first.workItem.state).toBe("watch_pr_status_checks")
                }

                const persisted = (yield* sql.unsafe(
                  `SELECT check_start_anchor_at, check_start_observed_head_sha,
                          check_start_observed_head_at
                   FROM work_item WHERE id = ?`,
                  [created.id],
                )) as readonly {
                  readonly check_start_anchor_at: number | null
                  readonly check_start_observed_head_sha: string | null
                  readonly check_start_observed_head_at: number | null
                }[]
                expect(persisted[0]?.check_start_observed_head_sha).toBe(
                  "undated-head",
                )
                // Last PR Change is later of creation (epoch) and first observation.
                expect(persisted[0]?.check_start_anchor_at).toBe(
                  persisted[0]?.check_start_observed_head_at,
                )
                return {
                  workItemId: created.id,
                  anchorAt: persisted[0]!.check_start_anchor_at!,
                }
              }),
              makeRestartTestLayer(steps, dbPath),
            ),
          ),
        )

        // Fresh services against the same file DB — no in-memory timing retained.
        await Effect.runPromise(
          Effect.scoped(
            Effect.provide(
              Effect.gen(function* () {
                const lifecycle = yield* WorkItemLifecycle
                const queue = yield* QueueService
                const sql = yield* SqlClient.SqlClient

                const persisted = (yield* sql.unsafe(
                  `SELECT check_start_anchor_at, check_start_observed_head_sha,
                          check_start_observed_head_at
                   FROM work_item WHERE id = ?`,
                  [established.workItemId],
                )) as readonly {
                  readonly check_start_anchor_at: number | null
                  readonly check_start_observed_head_sha: string | null
                  readonly check_start_observed_head_at: number | null
                }[]
                expect(persisted[0]?.check_start_anchor_at).toBe(
                  established.anchorAt,
                )
                expect(persisted[0]?.check_start_observed_head_sha).toBe(
                  "undated-head",
                )

                yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
                const claimed = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
                expect(Option.isSome(claimed)).toBe(true)
                if (Option.isNone(claimed)) {
                  return yield* Effect.die("expected queued watch")
                }
                yield* TestClock.setTime(
                  established.anchorAt + CHECK_START_DEADLINE_MS - 1,
                )
                const stillWaiting = yield* lifecycle.runStep(
                  (claimed.value.payload as { stepRunId: string }).stepRunId,
                )
                expect(stillWaiting._tag).toBe("processed")
                if (stillWaiting._tag === "processed") {
                  expect(stillWaiting.workItem.state).toBe(
                    "watch_pr_status_checks",
                  )
                }

                yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
                const claimed2 = yield* queue.rawClaim(
                  WORK_ITEM_LIFECYCLE_QUEUE,
                )
                expect(Option.isSome(claimed2)).toBe(true)
                if (Option.isNone(claimed2)) {
                  return yield* Effect.die("expected queued watch")
                }
                yield* TestClock.setTime(
                  established.anchorAt + CHECK_START_DEADLINE_MS,
                )
                const advanced = yield* lifecycle.runStep(
                  (claimed2.value.payload as { stepRunId: string }).stepRunId,
                )
                expect(advanced._tag).toBe("processed")
                if (advanced._tag === "processed") {
                  expect(advanced.workItem.state).toBe("decide_pr_merge")
                }
              }),
              makeRestartTestLayer(steps, dbPath),
            ),
          ),
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it("preserves a conservative persisted anchor when Last PR Change is older", () => {
      const conservativeAnchor = 5_000_000
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        watchPrStatusChecks: () =>
          Effect.succeed({
            _tag: "no_checks" as const,
            createdAt: new Date(1_000_000),
            headSha: "old-head",
            headPushedAt: new Date(1_000_000),
            isDraft: false,
          }),
      }

      return Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              yield* TestClock.setTime(conservativeAnchor)
              const lifecycle = yield* WorkItemLifecycle
              const sql = yield* SqlClient.SqlClient
              const { repository, issue } = yield* seedActionableIssue
              const created = yield* lifecycle.implementNow(
                repository.id,
                issue.githubIssueNumber,
              )

              for (let index = 0; index < 8; index += 1) {
                yield* TestClock.adjust(1_000)
                yield* claimAndRunPending
              }
              yield* forgetCreatePrDraftProvenance(created.id)

              // Simulate migration backfill: unfinished Work Item already has a
              // conservative anchor with no bound head SHA.
              yield* sql.unsafe(
                `UPDATE work_item
                 SET check_start_anchor_at = ?,
                     check_start_anchor_head_sha = NULL,
                     check_start_observed_head_sha = NULL,
                     check_start_observed_head_at = NULL
                 WHERE id = ?`,
                [conservativeAnchor, created.id],
              )

              yield* TestClock.setTime(conservativeAnchor + 1_000)
              yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
              const first = yield* claimAndRunPending
              expect(first._tag).toBe("processed")
              if (first._tag === "processed") {
                expect(first.workItem.state).toBe("watch_pr_status_checks")
              }

              const persisted = (yield* sql.unsafe(
                `SELECT check_start_anchor_at, check_start_anchor_head_sha
                 FROM work_item WHERE id = ?`,
                [created.id],
              )) as readonly {
                readonly check_start_anchor_at: number | null
                readonly check_start_anchor_head_sha: string | null
              }[]
              expect(persisted[0]?.check_start_anchor_at).toBe(
                conservativeAnchor,
              )
              expect(persisted[0]?.check_start_anchor_head_sha).toBe("old-head")

              yield* TestClock.setTime(
                conservativeAnchor + CHECK_START_DEADLINE_MS - 1,
              )
              yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
              const stillWaiting = yield* claimAndRunPending
              expect(stillWaiting._tag).toBe("processed")
              if (stillWaiting._tag === "processed") {
                expect(stillWaiting.workItem.state).toBe(
                  "watch_pr_status_checks",
                )
              }

              yield* TestClock.setTime(
                conservativeAnchor + CHECK_START_DEADLINE_MS,
              )
              yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
              const advanced = yield* claimAndRunPending
              expect(advanced._tag).toBe("processed")
              if (advanced._tag === "processed") {
                expect(advanced.workItem.state).toBe("decide_pr_merge")
              }
            }),
            makeTestLayer(steps).pipe(Layer.provideMerge(TestClock.layer())),
          ),
        ),
      )
    })

    it("takes the later of PR creation and current-head push as Last PR Change", () => {
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        watchPrStatusChecks: () =>
          Effect.succeed({
            _tag: "succeeded" as const,
            createdAt: new Date(1_000_000),
            headSha: "head-a",
            headPushedAt: new Date(1_050_000),
            isDraft: false,
          }),
      }

      return Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              yield* TestClock.setTime(1_050_000)
              const lifecycle = yield* WorkItemLifecycle
              const sql = yield* SqlClient.SqlClient
              const { repository, issue } = yield* seedActionableIssue
              const created = yield* lifecycle.implementNow(
                repository.id,
                issue.githubIssueNumber,
              )

              for (let index = 0; index < 8; index += 1) {
                yield* TestClock.adjust(1_000)
                yield* claimAndRunPending
              }
              yield* forgetCreatePrDraftProvenance(created.id)

              yield* TestClock.adjust(1_000)
              const early = yield* claimAndRunPending
              expect(early._tag).toBe("processed")
              if (early._tag === "processed") {
                expect(early.workItem.state).toBe("watch_pr_status_checks")
              }

              const anchors = (yield* sql.unsafe(
                `SELECT check_start_anchor_at FROM work_item WHERE id = ?`,
                [created.id],
              )) as readonly { readonly check_start_anchor_at: number | null }[]
              expect(anchors[0]?.check_start_anchor_at).toBe(1_050_000)

              yield* TestClock.setTime(1_050_000 + 89_999)
              yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
              const stillWaiting = yield* claimAndRunPending
              expect(stillWaiting._tag).toBe("processed")
              if (stillWaiting._tag === "processed") {
                expect(stillWaiting.workItem.state).toBe(
                  "watch_pr_status_checks",
                )
              }

              yield* TestClock.setTime(1_050_000 + CHECK_START_DEADLINE_MS)
              yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
              const ready = yield* claimAndRunPending
              expect(ready._tag).toBe("processed")
              if (ready._tag === "processed") {
                expect(ready.workItem.state).toBe("decide_pr_merge")
              }
            }),
            makeTestLayer(steps).pipe(Layer.provideMerge(TestClock.layer())),
          ),
        ),
      )
    })

    it("honors a GitHub push time slightly ahead of the harness clock", () => {
      const harnessNow = 1_000_000
      const githubPushAt = harnessNow + 5_000
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        watchPrStatusChecks: () =>
          Effect.succeed({
            _tag: "no_checks" as const,
            createdAt: new Date(harnessNow - 60_000),
            headSha: "skew-head",
            headPushedAt: new Date(githubPushAt),
            isDraft: false,
          }),
      }

      return Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              yield* TestClock.setTime(harnessNow)
              const lifecycle = yield* WorkItemLifecycle
              const sql = yield* SqlClient.SqlClient
              const { repository, issue } = yield* seedActionableIssue
              const created = yield* lifecycle.implementNow(
                repository.id,
                issue.githubIssueNumber,
              )

              for (let index = 0; index < 8; index += 1) {
                yield* TestClock.adjust(1_000)
                yield* claimAndRunPending
              }
              yield* forgetCreatePrDraftProvenance(created.id)

              yield* TestClock.setTime(harnessNow + 8_000)
              yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
              const first = yield* claimAndRunPending
              expect(first._tag).toBe("processed")
              if (first._tag === "processed") {
                expect(first.workItem.state).toBe("watch_pr_status_checks")
              }

              const anchors = (yield* sql.unsafe(
                `SELECT check_start_anchor_at FROM work_item WHERE id = ?`,
                [created.id],
              )) as readonly { readonly check_start_anchor_at: number | null }[]
              expect(anchors[0]?.check_start_anchor_at).toBe(githubPushAt)

              // Still before githubPushAt + 90s even though harness has advanced past push.
              yield* TestClock.setTime(githubPushAt + 89_999)
              yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
              const stillWaiting = yield* claimAndRunPending
              expect(stillWaiting._tag).toBe("processed")
              if (stillWaiting._tag === "processed") {
                expect(stillWaiting.workItem.state).toBe(
                  "watch_pr_status_checks",
                )
              }

              yield* TestClock.setTime(githubPushAt + CHECK_START_DEADLINE_MS)
              yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
              const ready = yield* claimAndRunPending
              expect(ready._tag).toBe("processed")
              if (ready._tag === "processed") {
                expect(ready.workItem.state).toBe("decide_pr_merge")
              }
            }),
            makeTestLayer(steps).pipe(Layer.provideMerge(TestClock.layer())),
          ),
        ),
      )
    })

    it("does not restart the deadline when a pushed head later omits push time", () => {
      const snapshots = [
        {
          _tag: "no_checks" as const,
          createdAt: new Date(1_000_000),
          headSha: "head-a",
          headPushedAt: new Date(1_050_000),
          isDraft: false,
        },
        {
          _tag: "no_checks" as const,
          createdAt: new Date(1_000_000),
          headSha: "head-a",
          headPushedAt: null,
          isDraft: false,
        },
      ]
      let index = 0
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        watchPrStatusChecks: () =>
          Effect.succeed(snapshots[Math.min(index++, snapshots.length - 1)]!),
      }

      return Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              yield* TestClock.setTime(1_050_000)
              const lifecycle = yield* WorkItemLifecycle
              const sql = yield* SqlClient.SqlClient
              const { repository, issue } = yield* seedActionableIssue
              const created = yield* lifecycle.implementNow(
                repository.id,
                issue.githubIssueNumber,
              )

              for (let index = 0; index < 8; index += 1) {
                yield* TestClock.adjust(1_000)
                yield* claimAndRunPending
              }
              yield* forgetCreatePrDraftProvenance(created.id)

              yield* TestClock.adjust(1_000)
              const first = yield* claimAndRunPending
              expect(first._tag).toBe("processed")
              if (first._tag === "processed") {
                expect(first.workItem.state).toBe("watch_pr_status_checks")
              }

              const afterPush = (yield* sql.unsafe(
                `SELECT check_start_anchor_at, check_start_observed_head_at
                 FROM work_item WHERE id = ?`,
                [created.id],
              )) as readonly {
                readonly check_start_anchor_at: number | null
                readonly check_start_observed_head_at: number | null
              }[]
              expect(afterPush[0]?.check_start_anchor_at).toBe(1_050_000)
              expect(afterPush[0]?.check_start_observed_head_at).toBeNull()

              // Later observation still has the same head but no push time.
              yield* TestClock.setTime(1_080_000)
              yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
              const second = yield* claimAndRunPending
              expect(second._tag).toBe("processed")
              if (second._tag === "processed") {
                expect(second.workItem.state).toBe("watch_pr_status_checks")
              }

              const afterOmit = (yield* sql.unsafe(
                `SELECT check_start_anchor_at, check_start_observed_head_at
                 FROM work_item WHERE id = ?`,
                [created.id],
              )) as readonly {
                readonly check_start_anchor_at: number | null
                readonly check_start_observed_head_at: number | null
              }[]
              expect(afterOmit[0]?.check_start_anchor_at).toBe(1_050_000)
              // No new observation fallback is recorded for an already-pushed head.
              expect(afterOmit[0]?.check_start_observed_head_at).toBeNull()
            }),
            makeTestLayer(steps).pipe(Layer.provideMerge(TestClock.layer())),
          ),
        ),
      )
    })

    it("keeps actual pending checks polling after the Check-Start Deadline", () => {
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        watchPrStatusChecks: () =>
          Effect.succeed({
            _tag: "pending" as const,
            createdAt: new Date(0),
            headSha: "pending-head",
            headPushedAt: new Date(0),
            isDraft: false,
          }),
      }

      return Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              yield* TestClock.setTime(1_000_000)
              const lifecycle = yield* WorkItemLifecycle
              const sql = yield* SqlClient.SqlClient
              const { repository, issue } = yield* seedActionableIssue
              yield* lifecycle.implementNow(
                repository.id,
                issue.githubIssueNumber,
              )

              for (let index = 0; index < 8; index += 1) {
                yield* TestClock.adjust(1_000)
                yield* claimAndRunPending
              }

              yield* TestClock.adjust(1_000)
              const afterDeadline = yield* claimAndRunPending
              expect(afterDeadline._tag).toBe("processed")
              if (afterDeadline._tag === "processed") {
                expect(afterDeadline.workItem.state).toBe(
                  "watch_pr_status_checks",
                )
              }
              const delayed = (yield* sql.unsafe(
                `SELECT available_at, created_at FROM job_queue`,
              )) as readonly {
                readonly available_at: number
                readonly created_at: number
              }[]
              expect(delayed).toHaveLength(1)
              expect(delayed[0]!.available_at - delayed[0]!.created_at).toBe(
                30_000,
              )
            }),
            makeTestLayer(steps).pipe(Layer.provideMerge(TestClock.layer())),
          ),
        ),
      )
    })

    it("stops blocking on Expected checks at the Check-Start Deadline", () => {
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        watchPrStatusChecks: () =>
          Effect.succeed({
            _tag: "expected" as const,
            createdAt: new Date(0),
            headSha: "expected-head",
            headPushedAt: new Date(0),
            isDraft: false,
          }),
      }

      return Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              yield* TestClock.setTime(1_000_000)
              const lifecycle = yield* WorkItemLifecycle
              const { repository, issue } = yield* seedActionableIssue
              const created = yield* lifecycle.implementNow(
                repository.id,
                issue.githubIssueNumber,
              )

              for (let index = 0; index < 8; index += 1) {
                yield* TestClock.adjust(1_000)
                yield* claimAndRunPending
              }
              yield* forgetCreatePrDraftProvenance(created.id)

              yield* TestClock.adjust(1_000)
              const afterDeadline = yield* claimAndRunPending
              expect(afterDeadline._tag).toBe("processed")
              if (afterDeadline._tag === "processed") {
                expect(afterDeadline.workItem.state).toBe("decide_pr_merge")
              }
            }),
            makeTestLayer(steps).pipe(Layer.provideMerge(TestClock.layer())),
          ),
        ),
      )
    })

    it("advances a settled draft to Mark PR Ready without waiting for the Check-Start Deadline", () => {
      const anchorInstant = 1_008_000
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        watchPrStatusChecks: () =>
          Effect.succeed({
            _tag: "succeeded" as const,
            createdAt: new Date(anchorInstant),
            headSha: "draft-head",
            headPushedAt: new Date(anchorInstant),
            isDraft: true,
          }),
      }

      return Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              yield* TestClock.setTime(1_000_000)
              const lifecycle = yield* WorkItemLifecycle
              const { repository, issue } = yield* seedActionableIssue
              yield* lifecycle.implementNow(
                repository.id,
                issue.githubIssueNumber,
              )

              for (let index = 0; index < 8; index += 1) {
                yield* TestClock.adjust(1_000)
                yield* claimAndRunPending
              }

              // Still well before the 90s deadline for this head.
              yield* TestClock.setTime(anchorInstant + 1_000)
              const afterWatch = yield* claimAndRunPending
              expect(afterWatch._tag).toBe("processed")
              if (afterWatch._tag === "processed") {
                expect(afterWatch.workItem.state).toBe(
                  "mark_pr_ready_for_review",
                )
              }
            }),
            makeTestLayer(steps).pipe(Layer.provideMerge(TestClock.layer())),
          ),
        ),
      )
    })

    it("returns Mark PR Ready to Watch with a fresh ready-phase anchor and only then Decides after 90s", () => {
      let prIsDraft = true
      let markReadyCalls = 0
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        watchPrStatusChecks: () =>
          Effect.succeed({
            _tag: "succeeded" as const,
            createdAt: new Date(0),
            headSha: "ready-phase-head",
            headPushedAt: new Date(0),
            isDraft: prIsDraft,
          }),
        markPrReadyForReview: () => {
          markReadyCalls += 1
          prIsDraft = false
          return Effect.void
        },
      }

      return Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              yield* TestClock.setTime(1_000_000)
              const lifecycle = yield* WorkItemLifecycle
              const sql = yield* SqlClient.SqlClient
              const { repository, issue } = yield* seedActionableIssue
              const created = yield* lifecycle.implementNow(
                repository.id,
                issue.githubIssueNumber,
              )

              for (let index = 0; index < 8; index += 1) {
                yield* TestClock.adjust(1_000)
                yield* claimAndRunPending
              }
              yield* TestClock.adjust(1_000)
              const afterDraftWatch = yield* claimAndRunPending
              expect(afterDraftWatch._tag).toBe("processed")
              if (afterDraftWatch._tag === "processed") {
                expect(afterDraftWatch.workItem.state).toBe(
                  "mark_pr_ready_for_review",
                )
              }

              const markReadyAt = 2_000_000
              yield* TestClock.setTime(markReadyAt)
              const afterMarkReady = yield* claimAndRunPending
              expect(afterMarkReady._tag).toBe("processed")
              if (afterMarkReady._tag === "processed") {
                expect(afterMarkReady.workItem.state).toBe(
                  "watch_pr_status_checks",
                )
              }
              expect(markReadyCalls).toBe(1)

              const anchors = (yield* sql.unsafe(
                `SELECT check_start_anchor_at, check_start_last_observed_is_draft
                 FROM work_item WHERE id = ?`,
                [created.id],
              )) as readonly {
                readonly check_start_anchor_at: number | null
                readonly check_start_last_observed_is_draft: number | null
              }[]
              expect(anchors[0]?.check_start_anchor_at).toBe(markReadyAt)
              expect(anchors[0]?.check_start_last_observed_is_draft).toBe(0)

              // Ready phase cannot Decide before the fresh 90s window.
              yield* TestClock.setTime(markReadyAt + 89_999)
              yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
              const stillWatching = yield* claimAndRunPending
              expect(stillWatching._tag).toBe("processed")
              if (stillWatching._tag === "processed") {
                expect(stillWatching.workItem.state).toBe(
                  "watch_pr_status_checks",
                )
              }

              yield* TestClock.setTime(markReadyAt + CHECK_START_DEADLINE_MS)
              yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
              const afterReadyWindow = yield* claimAndRunPending
              expect(afterReadyWindow._tag).toBe("processed")
              if (afterReadyWindow._tag === "processed") {
                expect(afterReadyWindow.workItem.state).toBe("decide_pr_merge")
              }
              expect(markReadyCalls).toBe(1)
            }),
            makeTestLayer(steps).pipe(Layer.provideMerge(TestClock.layer())),
          ),
        ),
      )
    })

    it("creates a durable ready-phase anchor on first external draft-to-ready observation", async () => {
      const root = await mkdtemp(join(tmpdir(), "rfa-draft-ready-restart-"))
      const dbPath = join(root, "restart.db")
      try {
        const established = await Effect.runPromise(
          Effect.scoped(
            Effect.provide(
              Effect.gen(function* () {
                yield* TestClock.setTime(1_000_000)
                const lifecycle = yield* WorkItemLifecycle
                const sql = yield* SqlClient.SqlClient
                const { repository, issue } = yield* seedActionableIssue
                const created = yield* lifecycle.implementNow(
                  repository.id,
                  issue.githubIssueNumber,
                )

                for (let index = 0; index < 8; index += 1) {
                  yield* TestClock.adjust(1_000)
                  yield* claimAndRunPending
                }

                // Pending draft records draft observation without Mark Ready.
                yield* TestClock.setTime(1_008_000)
                const draftPoll = yield* claimAndRunPending
                expect(draftPoll._tag).toBe("processed")
                if (draftPoll._tag === "processed") {
                  expect(draftPoll.workItem.state).toBe(
                    "watch_pr_status_checks",
                  )
                }

                const persisted = (yield* sql.unsafe(
                  `SELECT check_start_last_observed_is_draft
                   FROM work_item WHERE id = ?`,
                  [created.id],
                )) as readonly {
                  readonly check_start_last_observed_is_draft: number | null
                }[]
                expect(persisted[0]?.check_start_last_observed_is_draft).toBe(1)
                return { workItemId: created.id }
              }),
              makeRestartTestLayer(
                {
                  ...successfulSteps,
                  watchPrStatusChecks: () =>
                    Effect.succeed({
                      _tag: "pending" as const,
                      createdAt: new Date(1_000_000),
                      headSha: "external-ready-head",
                      headPushedAt: new Date(1_000_000),
                      isDraft: true,
                    }),
                },
                dbPath,
              ),
            ),
          ),
        )

        const readyObservedAt = 1_050_000
        await Effect.runPromise(
          Effect.scoped(
            Effect.provide(
              Effect.gen(function* () {
                const lifecycle = yield* WorkItemLifecycle
                const sql = yield* SqlClient.SqlClient
                const queue = yield* QueueService

                const before = (yield* sql.unsafe(
                  `SELECT check_start_last_observed_is_draft
                   FROM work_item WHERE id = ?`,
                  [established.workItemId],
                )) as readonly {
                  readonly check_start_last_observed_is_draft: number | null
                }[]
                expect(before[0]?.check_start_last_observed_is_draft).toBe(1)

                yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
                const claimed = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
                expect(Option.isSome(claimed)).toBe(true)
                if (Option.isNone(claimed)) {
                  return yield* Effect.die("expected queued watch")
                }
                yield* TestClock.setTime(readyObservedAt)
                const afterReady = yield* lifecycle.runStep(
                  (claimed.value.payload as { stepRunId: string }).stepRunId,
                )
                expect(afterReady._tag).toBe("processed")
                if (afterReady._tag === "processed") {
                  expect(afterReady.workItem.state).toBe(
                    "watch_pr_status_checks",
                  )
                }

                const after = (yield* sql.unsafe(
                  `SELECT check_start_last_observed_is_draft, check_start_anchor_at
                   FROM work_item WHERE id = ?`,
                  [established.workItemId],
                )) as readonly {
                  readonly check_start_last_observed_is_draft: number | null
                  readonly check_start_anchor_at: number | null
                }[]
                expect(after[0]?.check_start_last_observed_is_draft).toBe(0)
                expect(after[0]?.check_start_anchor_at).toBe(readyObservedAt)

                yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
                const claimed2 = yield* queue.rawClaim(
                  WORK_ITEM_LIFECYCLE_QUEUE,
                )
                expect(Option.isSome(claimed2)).toBe(true)
                if (Option.isNone(claimed2)) {
                  return yield* Effect.die("expected queued watch")
                }
                yield* TestClock.setTime(
                  readyObservedAt + CHECK_START_DEADLINE_MS - 1,
                )
                const stillWaiting = yield* lifecycle.runStep(
                  (claimed2.value.payload as { stepRunId: string }).stepRunId,
                )
                expect(stillWaiting._tag).toBe("processed")
                if (stillWaiting._tag === "processed") {
                  expect(stillWaiting.workItem.state).toBe(
                    "watch_pr_status_checks",
                  )
                }

                yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
                const claimed3 = yield* queue.rawClaim(
                  WORK_ITEM_LIFECYCLE_QUEUE,
                )
                expect(Option.isSome(claimed3)).toBe(true)
                if (Option.isNone(claimed3)) {
                  return yield* Effect.die("expected queued watch")
                }
                yield* TestClock.setTime(
                  readyObservedAt + CHECK_START_DEADLINE_MS,
                )
                const decided = yield* lifecycle.runStep(
                  (claimed3.value.payload as { stepRunId: string }).stepRunId,
                )
                expect(decided._tag).toBe("processed")
                if (decided._tag === "processed") {
                  expect(decided.workItem.state).toBe("decide_pr_merge")
                }
              }),
              makeRestartTestLayer(
                {
                  ...successfulSteps,
                  watchPrStatusChecks: () =>
                    Effect.succeed({
                      _tag: "succeeded" as const,
                      createdAt: new Date(1_000_000),
                      headSha: "external-ready-head",
                      headPushedAt: new Date(1_000_000),
                      isDraft: false,
                    }),
                  markPrReadyForReview: () =>
                    Effect.die("Mark PR Ready must not run for external ready"),
                },
                dbPath,
              ),
            ),
          ),
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it("keeps draft pending, conflict, and handoff priority ahead of Mark PR Ready", () => {
      const runDraftPriority = (
        status: {
          readonly _tag: "pending" | "conflict" | "handoff_needed"
          readonly retiredCheckIds?: readonly string[]
          readonly createdAt: Date
          readonly headSha: string
          readonly headPushedAt: Date
          readonly isDraft: true
        },
        expectedNext:
          | "watch_pr_status_checks"
          | "resolve_pr_merge_conflict"
          | "investigate_pr_status_checks",
      ) => {
        const steps: LifecycleStepsShape = {
          ...successfulSteps,
          watchPrStatusChecks: () =>
            Effect.succeed(
              status._tag === "conflict"
                ? {
                    _tag: "conflict" as const,
                    retiredCheckIds: status.retiredCheckIds ?? [],
                    createdAt: status.createdAt,
                    headSha: status.headSha,
                    headPushedAt: status.headPushedAt,
                    isDraft: true,
                  }
                : status,
            ),
        }
        return Effect.runPromise(
          Effect.scoped(
            Effect.provide(
              Effect.gen(function* () {
                yield* TestClock.setTime(1_000_000)
                const lifecycle = yield* WorkItemLifecycle
                const { repository, issue } = yield* seedActionableIssue
                yield* lifecycle.implementNow(
                  repository.id,
                  issue.githubIssueNumber,
                )

                for (let index = 0; index < 8; index += 1) {
                  yield* TestClock.adjust(1_000)
                  yield* claimAndRunPending
                }

                yield* TestClock.adjust(1_000)
                const afterWatch = yield* claimAndRunPending
                expect(afterWatch._tag).toBe("processed")
                if (afterWatch._tag === "processed") {
                  expect(afterWatch.workItem.state).toBe(expectedNext)
                }
              }),
              makeTestLayer(steps).pipe(Layer.provideMerge(TestClock.layer())),
            ),
          ),
        )
      }

      return runDraftPriority(
        {
          _tag: "pending",
          createdAt: new Date(0),
          headSha: "draft-pending",
          headPushedAt: new Date(0),
          isDraft: true,
        },
        "watch_pr_status_checks",
      )
        .then(() =>
          runDraftPriority(
            {
              _tag: "conflict",
              retiredCheckIds: [],
              createdAt: new Date(0),
              headSha: "draft-conflict",
              headPushedAt: new Date(0),
              isDraft: true,
            },
            "resolve_pr_merge_conflict",
          ),
        )
        .then(() =>
          runDraftPriority(
            {
              _tag: "handoff_needed",
              createdAt: new Date(0),
              headSha: "draft-handoff",
              headPushedAt: new Date(0),
              isDraft: true,
            },
            "investigate_pr_status_checks",
          ),
        )
    })

    it("advances a draft failed aggregate with no unhandled terminals to Mark PR Ready", () => {
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        watchPrStatusChecks: () =>
          Effect.succeed({
            _tag: "failed" as const,
            createdAt: new Date(1_008_000),
            headSha: "draft-failed-head",
            headPushedAt: new Date(1_008_000),
            isDraft: true,
          }),
      }

      return Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              yield* TestClock.setTime(1_000_000)
              const lifecycle = yield* WorkItemLifecycle
              const { repository, issue } = yield* seedActionableIssue
              yield* lifecycle.implementNow(
                repository.id,
                issue.githubIssueNumber,
              )

              for (let index = 0; index < 8; index += 1) {
                yield* TestClock.adjust(1_000)
                yield* claimAndRunPending
              }

              yield* TestClock.setTime(1_009_000)
              const afterWatch = yield* claimAndRunPending
              expect(afterWatch._tag).toBe("processed")
              if (afterWatch._tag === "processed") {
                expect(afterWatch.workItem.state).toBe(
                  "mark_pr_ready_for_review",
                )
              }
            }),
            makeTestLayer(steps).pipe(Layer.provideMerge(TestClock.layer())),
          ),
        ),
      )
    })

    it("anchors first Watch of an externally-ready PR after Create PR draft provenance", () => {
      const readyObservedAt = 1_050_000
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        watchPrStatusChecks: () =>
          Effect.succeed({
            _tag: "succeeded" as const,
            // Old Last PR Change would already be past the deadline.
            createdAt: new Date(0),
            headSha: "external-before-watch",
            headPushedAt: new Date(0),
            isDraft: false,
          }),
        markPrReadyForReview: () =>
          Effect.die("Mark PR Ready must not run when already ready"),
      }

      return Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              yield* TestClock.setTime(1_000_000)
              const lifecycle = yield* WorkItemLifecycle
              const sql = yield* SqlClient.SqlClient
              const { repository, issue } = yield* seedActionableIssue
              const created = yield* lifecycle.implementNow(
                repository.id,
                issue.githubIssueNumber,
              )

              for (let index = 0; index < 8; index += 1) {
                yield* TestClock.adjust(1_000)
                yield* claimAndRunPending
              }

              const afterCreatePr = (yield* sql.unsafe(
                `SELECT check_start_last_observed_is_draft
                 FROM work_item WHERE id = ?`,
                [created.id],
              )) as readonly {
                readonly check_start_last_observed_is_draft: number | null
              }[]
              expect(afterCreatePr[0]?.check_start_last_observed_is_draft).toBe(
                1,
              )

              yield* TestClock.setTime(readyObservedAt)
              const firstWatch = yield* claimAndRunPending
              expect(firstWatch._tag).toBe("processed")
              if (firstWatch._tag === "processed") {
                // Fresh ready-phase anchor blocks Decide despite old Last PR Change.
                expect(firstWatch.workItem.state).toBe("watch_pr_status_checks")
              }

              const anchors = (yield* sql.unsafe(
                `SELECT check_start_anchor_at, check_start_last_observed_is_draft
                 FROM work_item WHERE id = ?`,
                [created.id],
              )) as readonly {
                readonly check_start_anchor_at: number | null
                readonly check_start_last_observed_is_draft: number | null
              }[]
              expect(anchors[0]?.check_start_anchor_at).toBe(readyObservedAt)
              expect(anchors[0]?.check_start_last_observed_is_draft).toBe(0)

              yield* TestClock.setTime(
                readyObservedAt + CHECK_START_DEADLINE_MS,
              )
              yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
              const afterDeadline = yield* claimAndRunPending
              expect(afterDeadline._tag).toBe("processed")
              if (afterDeadline._tag === "processed") {
                expect(afterDeadline.workItem.state).toBe("decide_pr_merge")
              }
            }),
            makeTestLayer(steps).pipe(Layer.provideMerge(TestClock.layer())),
          ),
        ),
      )
    })

    it("keeps a ready-phase anchor when Mark PR Ready is already-ready idempotent", () => {
      let markReadyCalls = 0
      let prIsDraft: boolean | null = true
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        watchPrStatusChecks: () =>
          Effect.succeed({
            _tag: "succeeded" as const,
            createdAt: new Date(0),
            headSha: "already-ready-head",
            headPushedAt: new Date(0),
            isDraft: prIsDraft,
          }),
        // GitHub no-op path: step succeeds; subsequent snapshots report ready.
        markPrReadyForReview: () => {
          markReadyCalls += 1
          prIsDraft = false
          return Effect.void
        },
      }

      return Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              yield* TestClock.setTime(1_000_000)
              const lifecycle = yield* WorkItemLifecycle
              const sql = yield* SqlClient.SqlClient
              const { repository, issue } = yield* seedActionableIssue
              const created = yield* lifecycle.implementNow(
                repository.id,
                issue.githubIssueNumber,
              )

              for (let index = 0; index < 8; index += 1) {
                yield* TestClock.adjust(1_000)
                yield* claimAndRunPending
              }
              yield* TestClock.adjust(1_000)
              const afterDraftWatch = yield* claimAndRunPending
              expect(afterDraftWatch._tag).toBe("processed")
              if (afterDraftWatch._tag === "processed") {
                expect(afterDraftWatch.workItem.state).toBe(
                  "mark_pr_ready_for_review",
                )
              }

              const markReadyAt = 2_500_000
              yield* TestClock.setTime(markReadyAt)
              const afterMark = yield* claimAndRunPending
              expect(afterMark._tag).toBe("processed")
              if (afterMark._tag === "processed") {
                expect(afterMark.workItem.state).toBe("watch_pr_status_checks")
              }
              expect(markReadyCalls).toBe(1)

              const anchors = (yield* sql.unsafe(
                `SELECT check_start_anchor_at, check_start_anchor_head_sha,
                        check_start_last_observed_is_draft
                 FROM work_item WHERE id = ?`,
                [created.id],
              )) as readonly {
                readonly check_start_anchor_at: number | null
                readonly check_start_anchor_head_sha: string | null
                readonly check_start_last_observed_is_draft: number | null
              }[]
              expect(anchors[0]?.check_start_anchor_at).toBe(markReadyAt)
              expect(anchors[0]?.check_start_anchor_head_sha).toBeNull()
              expect(anchors[0]?.check_start_last_observed_is_draft).toBe(0)

              // Next ready snapshot must not re-enter Mark or rewind the anchor.
              yield* TestClock.setTime(markReadyAt + 1_000)
              yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
              const afterReadyWatch = yield* claimAndRunPending
              expect(afterReadyWatch._tag).toBe("processed")
              if (afterReadyWatch._tag === "processed") {
                expect(afterReadyWatch.workItem.state).toBe(
                  "watch_pr_status_checks",
                )
              }
              expect(markReadyCalls).toBe(1)

              const afterReadyAnchors = (yield* sql.unsafe(
                `SELECT check_start_anchor_at FROM work_item WHERE id = ?`,
                [created.id],
              )) as readonly { readonly check_start_anchor_at: number | null }[]
              expect(afterReadyAnchors[0]?.check_start_anchor_at).toBe(
                markReadyAt,
              )

              yield* TestClock.setTime(markReadyAt + CHECK_START_DEADLINE_MS)
              yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
              const afterDeadline = yield* claimAndRunPending
              expect(afterDeadline._tag).toBe("processed")
              if (afterDeadline._tag === "processed") {
                expect(afterDeadline.workItem.state).toBe("decide_pr_merge")
              }
              expect(markReadyCalls).toBe(1)
            }),
            makeTestLayer(steps).pipe(Layer.provideMerge(TestClock.layer())),
          ),
        ),
      )
    })

    it("keeps polling when draft status is unknown rather than Decide or Mark Ready", () => {
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        watchPrStatusChecks: () =>
          Effect.succeed({
            _tag: "succeeded" as const,
            createdAt: new Date(0),
            headSha: "unknown-draft-head",
            headPushedAt: new Date(0),
            isDraft: null,
          }),
      }

      return Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              yield* TestClock.setTime(1_000_000)
              const lifecycle = yield* WorkItemLifecycle
              const { repository, issue } = yield* seedActionableIssue
              const created = yield* lifecycle.implementNow(
                repository.id,
                issue.githubIssueNumber,
              )

              for (let index = 0; index < 8; index += 1) {
                yield* TestClock.adjust(1_000)
                yield* claimAndRunPending
              }
              yield* forgetCreatePrDraftProvenance(created.id)

              yield* TestClock.adjust(1_000)
              const afterWatch = yield* claimAndRunPending
              expect(afterWatch._tag).toBe("processed")
              if (afterWatch._tag === "processed") {
                expect(afterWatch.workItem.state).toBe("watch_pr_status_checks")
              }
            }),
            makeTestLayer(steps).pipe(Layer.provideMerge(TestClock.layer())),
          ),
        ),
      )
    })

    it("rechecks pending PR checks after 30 seconds and hands failed checks to a human when requested", () => {
      const statuses = [
        watchResult("pending"),
        watchResult("handoff_needed"),
      ] as const
      let statusIndex = 0
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        watchPrStatusChecks: () =>
          Effect.succeed(
            statuses[statusIndex++] ?? watchResult("handoff_needed"),
          ),
        investigatePrStatusChecks: () =>
          Effect.succeed({
            _tag: "needs_human",
            reason: "A repository owner must approve the workflow",
            handledCheckIds: ["psc-needs-human"],
          }),
      }

      return runWithSteps(
        steps,
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const sql = yield* SqlClient.SqlClient
          const { repository, issue } = yield* seedActionableIssue
          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )

          for (let index = 0; index < 8; index += 1) {
            yield* claimAndRunPending
          }
          yield* forgetCreatePrDraftProvenance(created.id)

          const pending = yield* claimAndRunPending
          expect(pending._tag).toBe("processed")
          if (pending._tag === "processed") {
            expect(pending.workItem.state).toBe("watch_pr_status_checks")
            expect(pending.workItem.stepRuns.at(-2)?.status).toBe("succeeded")
            expect(pending.workItem.stepRuns.at(-1)?.status).toBe("queued")
          }

          const delayed = (yield* sql.unsafe(
            `SELECT available_at, created_at FROM job_queue`,
          )) as readonly {
            readonly available_at: number
            readonly created_at: number
          }[]
          expect(delayed).toHaveLength(1)
          expect(delayed[0]!.available_at - delayed[0]!.created_at).toBe(30_000)

          yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
          const failed = yield* claimAndRunPending
          expect(failed._tag).toBe("processed")
          if (failed._tag === "processed") {
            expect(failed.workItem.state).toBe("investigate_pr_status_checks")
            const investigation = failed.workItem.stepRuns.at(-1)!
            const preceding = failed.workItem.stepRuns.at(-2)!
            const tiedQueuedAt = investigation.queuedAt.getTime()
            yield* sql.unsafe(
              `UPDATE step_run SET queued_at = ? WHERE id IN (?, ?)`,
              [tiedQueuedAt, investigation.id, preceding.id],
            )
            yield* sql.unsafe(`UPDATE step_run SET id = ? WHERE id = ?`, [
              "srun-ZZZZZZZZZZZZZZZZZZZZZZZZZZ",
              preceding.id,
            ])
          }

          const now = Date.now()
          yield* sql.unsafe(
            `INSERT INTO pr_status_check (
               id, work_item_id, external_id, name, outcome,
               handled_at, observed_at, created_at, updated_at
             ) VALUES ('psc-needs-human', ?, 'checkrun:needs-human', 'deploy', 'red', NULL, ?, ?, ?)`,
            [created.id, now, now, now],
          )
          yield* sql.unsafe(
            `INSERT INTO pr_status_check (
               id, work_item_id, external_id, name, outcome,
               handled_at, observed_at, created_at, updated_at
             ) VALUES ('psc-other-handoff', ?, 'checkrun:other', 'test', 'green', NULL, ?, ?, ?)`,
            [created.id, now, now, now],
          )

          const investigated = yield* claimAndRunPending
          expect(investigated._tag).toBe("processed")
          if (investigated._tag === "processed") {
            expect(investigated.workItem.state).toBe("needs_human")
            expect(investigated.workItem.failureCode).toBe("needs_human")
            expect(investigated.workItem.failureMessage).toBe(
              "A repository owner must approve the workflow",
            )
          }

          const final = yield* lifecycle.getWorkItem(created.id)
          expect(final.state).toBe("needs_human")
          const blocked = yield* Effect.flip(
            lifecycle.implementNow(repository.id, issue.githubIssueNumber),
          )
          expect(blocked).toBeInstanceOf(UnfinishedWorkItemExistsError)

          const handledChecks = (yield* sql.unsafe(
            `SELECT id, handled_at, handled_by_step_run_id
             FROM pr_status_check
             WHERE id IN ('psc-needs-human', 'psc-other-handoff')
             ORDER BY id`,
          )) as readonly {
            readonly id: string
            readonly handled_at: number | null
            readonly handled_by_step_run_id: string | null
          }[]
          const targetCheck = handledChecks.find(
            (check) => check.id === "psc-needs-human",
          )
          expect(targetCheck?.handled_at).not.toBeNull()
          expect(targetCheck?.handled_by_step_run_id).toBe(
            final.stepRuns.at(-1)?.id,
          )
          yield* sql.unsafe(
            `UPDATE pr_status_check
             SET handled_at = ?,
                 handled_by_step_run_id = ?,
                 updated_at = ?
             WHERE id = 'psc-other-handoff'`,
            [
              targetCheck!.handled_at,
              created.stepRuns[0]?.id,
              targetCheck!.handled_at,
            ],
          )

          const retried = yield* lifecycle.retry(created.id)
          expect(retried.state).toBe("investigate_pr_status_checks")
          expect(retried.failureCode).toBeNull()
          expect(retried.failureMessage).toBeNull()
          expect(retried.stepRuns.at(-1)).toMatchObject({
            step: "investigate_pr_status_checks",
            status: "queued",
          })
          const reopenedChecks = (yield* sql.unsafe(
            `SELECT id, handled_at, handled_by_step_run_id
             FROM pr_status_check
             WHERE id IN ('psc-needs-human', 'psc-other-handoff')
             ORDER BY id`,
          )) as readonly {
            readonly id: string
            readonly handled_at: number | null
            readonly handled_by_step_run_id: string | null
          }[]
          expect(
            reopenedChecks.find((check) => check.id === "psc-needs-human"),
          ).toMatchObject({ handled_at: null, handled_by_step_run_id: null })
          expect(
            reopenedChecks.find((check) => check.id === "psc-other-handoff"),
          ).toMatchObject({
            handled_at: targetCheck!.handled_at,
            handled_by_step_run_id: created.stepRuns[0]?.id,
          })
        }),
      )
    })

    it("enters Needs Human when automated review rerun budget is exhausted and releases the Worker Slot", () => {
      const checkId = "psc-rerun-exhausted"
      const reason =
        "Automated review rerun limit reached (3) for Claude Code Review; inspect or run the review manually, then Retry checks."
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        watchPrStatusChecks: () =>
          Effect.succeed(watchResult("handoff_needed")),
        investigatePrStatusChecks: () =>
          Effect.succeed({
            _tag: "needs_human",
            reason,
            handledCheckIds: [checkId],
          }),
      }

      return runWithSteps(
        steps,
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const sql = yield* SqlClient.SqlClient
          const { repository, issue } = yield* seedActionableIssue
          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )

          for (let index = 0; index < 8; index += 1) {
            yield* claimAndRunPending
          }
          yield* forgetCreatePrDraftProvenance(created.id)

          const watched = yield* claimAndRunPending
          expect(watched._tag).toBe("processed")
          if (watched._tag === "processed") {
            expect(watched.workItem.state).toBe("investigate_pr_status_checks")
          }

          const now = Date.now()
          yield* sql.unsafe(
            `INSERT INTO pr_status_check (
               id, work_item_id, external_id, name, outcome,
               handled_at, observed_at, created_at, updated_at
             ) VALUES (?, ?, 'actions-job:review', 'Claude Code Review/claude-review', 'green', NULL, ?, ?, ?)`,
            [checkId, created.id, now, now, now],
          )

          const investigated = yield* claimAndRunPending
          expect(investigated._tag).toBe("processed")
          if (investigated._tag === "processed") {
            expect(investigated.workItem.state).toBe("needs_human")
            expect(investigated.workItem.failureMessage).toBe(reason)
            expect(investigated.workItem.holdsWorkerSlot).toBe(false)
          }

          const checks = (yield* sql.unsafe(
            `SELECT handled_at FROM pr_status_check WHERE id = ?`,
            [checkId],
          )) as readonly { handled_at: number | null }[]
          expect(checks[0]?.handled_at).not.toBeNull()

          const queued = (yield* sql.unsafe(
            `SELECT COUNT(*) AS count FROM job_queue`,
          )) as readonly { count: number }[]
          expect(Number(queued[0]?.count)).toBe(0)
        }),
      )
    })

    it("returns PROCESSED investigation to Watch immediately without resetting the Check-Start Anchor", () => {
      const checkId = "psc-processed-noop"
      const priorAnchorAt = 1_000
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        watchPrStatusChecks: () =>
          Effect.succeed(watchResult("handoff_needed")),
        investigatePrStatusChecks: () =>
          Effect.succeed({
            _tag: "processed",
            handledCheckIds: [checkId],
          }),
      }

      return runWithSteps(
        steps,
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const sql = yield* SqlClient.SqlClient
          const { repository, issue } = yield* seedActionableIssue
          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )

          for (let index = 0; index < 8; index += 1) {
            yield* claimAndRunPending
          }
          yield* forgetCreatePrDraftProvenance(created.id)

          const watched = yield* claimAndRunPending
          expect(watched._tag).toBe("processed")
          if (watched._tag === "processed") {
            expect(watched.workItem.state).toBe("investigate_pr_status_checks")
          }

          const now = Date.now()
          yield* sql.unsafe(
            `UPDATE work_item
             SET check_start_anchor_at = ?, updated_at = ?
             WHERE id = ?`,
            [priorAnchorAt, now, created.id],
          )
          yield* sql.unsafe(
            `INSERT INTO pr_status_check (
               id, work_item_id, external_id, name, outcome,
               handled_at, observed_at, created_at, updated_at
             ) VALUES (?, ?, 'checkrun:processed-noop', 'lint', 'green', NULL, ?, ?, ?)`,
            [checkId, created.id, now, now, now],
          )

          const investigated = yield* claimAndRunPending
          expect(investigated._tag).toBe("processed")
          if (investigated._tag === "processed") {
            expect(investigated.workItem.state).toBe("watch_pr_status_checks")
            expect(investigated.workItem.failureMessage).toBeNull()
          }

          const checks = (yield* sql.unsafe(
            `SELECT handled_at, handled_by_step_run_id
             FROM pr_status_check
             WHERE id = ?`,
            [checkId],
          )) as readonly {
            readonly handled_at: number | null
            readonly handled_by_step_run_id: string | null
          }[]
          expect(checks[0]?.handled_at).not.toBeNull()

          const delayed = (yield* sql.unsafe(
            `SELECT available_at, created_at FROM job_queue`,
          )) as readonly { available_at: number; created_at: number }[]
          expect(delayed).toHaveLength(1)
          expect(delayed[0]!.available_at - delayed[0]!.created_at).toBe(0)

          const anchors = (yield* sql.unsafe(
            `SELECT check_start_anchor_at FROM work_item WHERE id = ?`,
            [created.id],
          )) as readonly { readonly check_start_anchor_at: number | null }[]
          expect(anchors[0]?.check_start_anchor_at).toBe(priorAnchorAt)
        }),
      )
    })

    it("records a fresh Check-Start Anchor and delayed Watch after CHECKS_TRIGGERED", () => {
      const checkId = "psc-checks-triggered"
      const priorAnchorAt = 1_000
      const investigateAt = 50_000
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        watchPrStatusChecks: () =>
          Effect.succeed(watchResult("handoff_needed")),
        investigatePrStatusChecks: () =>
          Effect.succeed({
            _tag: "checks_triggered",
            handledCheckIds: [checkId],
            checkStartAnchorRecorded: false,
          }),
      }

      return Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              yield* TestClock.setTime(0)
              const lifecycle = yield* WorkItemLifecycle
              const sql = yield* SqlClient.SqlClient
              const { repository, issue } = yield* seedActionableIssue
              const created = yield* lifecycle.implementNow(
                repository.id,
                issue.githubIssueNumber,
              )

              for (let index = 0; index < 8; index += 1) {
                yield* claimAndRunPending
              }
              yield* forgetCreatePrDraftProvenance(created.id)

              const watched = yield* claimAndRunPending
              expect(watched._tag).toBe("processed")
              if (watched._tag === "processed") {
                expect(watched.workItem.state).toBe(
                  "investigate_pr_status_checks",
                )
              }

              yield* TestClock.setTime(investigateAt)
              yield* sql.unsafe(
                `UPDATE work_item
                 SET check_start_anchor_at = ?, updated_at = ?
                 WHERE id = ?`,
                [priorAnchorAt, investigateAt, created.id],
              )
              yield* sql.unsafe(
                `INSERT INTO pr_status_check (
                   id, work_item_id, external_id, name, outcome,
                   handled_at, observed_at, created_at, updated_at
                 ) VALUES (?, ?, 'checkrun:triggered', 'lint', 'red', NULL, ?, ?, ?)`,
                [
                  checkId,
                  created.id,
                  investigateAt,
                  investigateAt,
                  investigateAt,
                ],
              )

              const investigated = yield* claimAndRunPending
              expect(investigated._tag).toBe("processed")
              if (investigated._tag === "processed") {
                expect(investigated.workItem.state).toBe(
                  "watch_pr_status_checks",
                )
              }

              const checks = (yield* sql.unsafe(
                `SELECT handled_at FROM pr_status_check WHERE id = ?`,
                [checkId],
              )) as readonly { readonly handled_at: number | null }[]
              expect(checks[0]?.handled_at).not.toBeNull()

              const delayed = (yield* sql.unsafe(
                `SELECT available_at, created_at FROM job_queue`,
              )) as readonly { available_at: number; created_at: number }[]
              expect(delayed).toHaveLength(1)
              expect(delayed[0]!.available_at - delayed[0]!.created_at).toBe(
                30_000,
              )

              const anchors = (yield* sql.unsafe(
                `SELECT check_start_anchor_at FROM work_item WHERE id = ?`,
                [created.id],
              )) as readonly { readonly check_start_anchor_at: number | null }[]
              expect(anchors[0]?.check_start_anchor_at).toBe(investigateAt)
            }),
            makeTestLayer(steps).pipe(Layer.provideMerge(TestClock.layer())),
          ),
        ),
      )
    })

    it("retires completed checks atomically when conflict resolution is queued and returns to delayed Watch", () => {
      const checkId = "psc-conflict-retired"
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        watchPrStatusChecks: () =>
          Effect.succeed({
            _tag: "conflict",
            retiredCheckIds: [checkId],
            ...settledTiming,
          }),
        resolvePrMergeConflict: () => Effect.succeed({ _tag: "processed" }),
      }

      return runWithSteps(
        steps,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const lifecycle = yield* WorkItemLifecycle
          const { repository, issue } = yield* seedActionableIssue
          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          for (let index = 0; index < 8; index += 1) {
            yield* claimAndRunPending
          }
          yield* forgetCreatePrDraftProvenance(created.id)

          const now = Date.now()
          yield* sql.unsafe(
            `INSERT INTO pr_status_check (
               id, work_item_id, external_id, name, outcome,
               handled_at, observed_at, created_at, updated_at
             ) VALUES (?, ?, 'checkrun:conflict', 'lint', 'red', NULL, ?, ?, ?)`,
            [checkId, created.id, now, now, now],
          )

          // 8 steps reach Create PR; this claim runs Watch → conflict.
          const watched = yield* claimAndRunPending
          expect(watched._tag).toBe("processed")
          if (watched._tag === "processed") {
            expect(watched.workItem.state).toBe("resolve_pr_merge_conflict")
            expect(watched.workItem.stepRuns.at(-1)?.step).toBe(
              "resolve_pr_merge_conflict",
            )
          }
          const checks = (yield* sql.unsafe(
            `SELECT handled_at FROM pr_status_check WHERE id = ?`,
            [checkId],
          )) as readonly { handled_at: number | null }[]
          expect(checks[0]?.handled_at).not.toBeNull()

          const resolved = yield* claimAndRunPending
          expect(resolved._tag).toBe("processed")
          if (resolved._tag === "processed") {
            expect(resolved.workItem.state).toBe("watch_pr_status_checks")
          }
          const delayed = (yield* sql.unsafe(
            `SELECT available_at, created_at FROM job_queue`,
          )) as readonly { available_at: number; created_at: number }[]
          expect(delayed).toHaveLength(1)
          expect(delayed[0]!.available_at - delayed[0]!.created_at).toBe(30_000)
        }),
      )
    })

    it("moves a merge conflict requiring human intervention to Needs Human", () => {
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        watchPrStatusChecks: () =>
          Effect.succeed({
            _tag: "conflict",
            retiredCheckIds: [],
            ...settledTiming,
          }),
        resolvePrMergeConflict: () =>
          Effect.succeed({
            _tag: "needs_human",
            reason: "The conflict requires a product decision",
          }),
      }

      return runWithSteps(
        steps,
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const { repository, issue } = yield* seedActionableIssue
          yield* lifecycle.implementNow(repository.id, issue.githubIssueNumber)
          for (let index = 0; index < 9; index += 1) {
            yield* claimAndRunPending
          }
          const resolved = yield* claimAndRunPending
          expect(resolved._tag).toBe("processed")
          if (resolved._tag === "processed") {
            expect(resolved.workItem.state).toBe("needs_human")
            expect(resolved.workItem.failureMessage).toBe(
              "The conflict requires a product decision",
            )
          }
        }),
      )
    })

    it("leaves handed-off checks unhandled when the lifecycle transition rolls back", () => {
      const checkId = "psc-transition-rollback"
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        watchPrStatusChecks: () =>
          Effect.succeed(watchResult("handoff_needed")),
        investigatePrStatusChecks: () =>
          Effect.succeed({
            _tag: "needs_human",
            reason: "A repository owner must approve the workflow",
            handledCheckIds: [checkId],
          }),
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

          for (let index = 0; index < 9; index += 1) {
            yield* claimAndRunPending
          }

          const now = Date.now()
          yield* sql.unsafe(
            `INSERT INTO pr_status_check (
               id, work_item_id, external_id, name, outcome,
               handled_at, observed_at, created_at, updated_at
             ) VALUES (?, ?, 'checkrun:rollback', 'deploy', 'red', NULL, ?, ?, ?)`,
            [checkId, created.id, now, now, now],
          )
          yield* sql.unsafe(
            `CREATE TRIGGER fail_investigate_transition
             BEFORE UPDATE ON work_item
             WHEN OLD.state = 'investigate_pr_status_checks'
             BEGIN
               SELECT RAISE(ABORT, 'injected transition failure');
             END`,
          )

          const claimed = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
          expect(Option.isSome(claimed)).toBe(true)
          if (Option.isNone(claimed)) {
            return yield* Effect.die("expected an investigation job")
          }
          const payload = claimed.value.payload as { stepRunId: string }
          const result = yield* Effect.result(
            lifecycle.runStep(payload.stepRunId),
          )
          expect(Result.isFailure(result)).toBe(true)

          const checks = (yield* sql.unsafe(
            `SELECT handled_at FROM pr_status_check WHERE id = ?`,
            [checkId],
          )) as readonly { readonly handled_at: number | null }[]
          expect(checks[0]?.handled_at).toBeNull()
        }),
      )
    })

    it("batches unhandled green results while aggregate is pending and waits for handoff before Mark PR Ready", () => {
      const watchStatuses = [
        watchResult("handoff_needed"),
        watchResult("pending"),
        watchResult("handoff_needed"),
        watchResult("succeeded"),
      ] as const
      let watchIndex = 0
      let investigations = 0
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        watchPrStatusChecks: () =>
          Effect.succeed(
            watchStatuses[watchIndex++] ?? watchResult("succeeded"),
          ),
        investigatePrStatusChecks: () => {
          investigations += 1
          return Effect.succeed({
            _tag: "processed" as const,
            handledCheckIds: [],
          })
        },
      }

      return runWithSteps(
        steps,
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const sql = yield* SqlClient.SqlClient
          const { repository, issue } = yield* seedActionableIssue
          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )

          for (let index = 0; index < 8; index += 1) {
            yield* claimAndRunPending
          }
          yield* forgetCreatePrDraftProvenance(created.id)

          const firstHandoff = yield* claimAndRunPending
          expect(firstHandoff._tag).toBe("processed")
          if (firstHandoff._tag === "processed") {
            expect(firstHandoff.workItem.state).toBe(
              "investigate_pr_status_checks",
            )
          }

          const afterFirstInvestigate = yield* claimAndRunPending
          expect(afterFirstInvestigate._tag).toBe("processed")
          if (afterFirstInvestigate._tag === "processed") {
            expect(afterFirstInvestigate.workItem.state).toBe(
              "watch_pr_status_checks",
            )
          }
          expect(investigations).toBe(1)

          yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
          const stillPending = yield* claimAndRunPending
          expect(stillPending._tag).toBe("processed")
          if (stillPending._tag === "processed") {
            expect(stillPending.workItem.state).toBe("watch_pr_status_checks")
          }

          yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
          const secondHandoff = yield* claimAndRunPending
          expect(secondHandoff._tag).toBe("processed")
          if (secondHandoff._tag === "processed") {
            expect(secondHandoff.workItem.state).toBe(
              "investigate_pr_status_checks",
            )
          }

          const afterSecondInvestigate = yield* claimAndRunPending
          expect(afterSecondInvestigate._tag).toBe("processed")
          if (afterSecondInvestigate._tag === "processed") {
            expect(afterSecondInvestigate.workItem.state).toBe(
              "watch_pr_status_checks",
            )
          }
          expect(investigations).toBe(2)

          yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
          const ready = yield* claimAndRunPending
          expect(ready._tag).toBe("processed")
          if (ready._tag === "processed") {
            expect(ready.workItem.state).toBe("decide_pr_merge")
          }
        }),
      )
    })

    it("stops retryably when investigation cannot recover red checks", () => {
      const checkId = "psc-unresolved-red"
      const failureMessage =
        "Manual fixing may be required. ActionLint failed twice on GitHub 503; restart did not help. Please fix or rerun the checks on GitHub, then click Retry checks."
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        watchPrStatusChecks: () =>
          Effect.succeed(watchResult("handoff_needed")),
        investigatePrStatusChecks: () =>
          Effect.fail(
            new PrStatusChecksUnresolvedError({ message: failureMessage }),
          ),
      }

      return runWithSteps(
        steps,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const lifecycle = yield* WorkItemLifecycle
          const { repository, issue } = yield* seedActionableIssue
          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )

          for (let index = 0; index < 8; index += 1) {
            yield* claimAndRunPending
          }
          yield* forgetCreatePrDraftProvenance(created.id)

          const now = Date.now()
          yield* sql.unsafe(
            `INSERT INTO pr_status_check (
               id, work_item_id, external_id, name, outcome,
               handled_at, observed_at, created_at, updated_at
             ) VALUES (?, ?, 'checkrun:unresolved', 'ActionLint', 'red', NULL, ?, ?, ?)`,
            [checkId, created.id, now, now, now],
          )

          const handoff = yield* claimAndRunPending
          expect(handoff._tag).toBe("processed")
          if (handoff._tag === "processed") {
            expect(handoff.workItem.state).toBe("investigate_pr_status_checks")
          }

          const investigated = yield* claimAndRunPending
          expect(investigated._tag).toBe("processed")
          if (investigated._tag === "processed") {
            expect(investigated.workItem.state).toBe(
              "investigate_pr_status_checks",
            )
            expect(investigated.workItem.failureCode).toBeNull()
            expect(investigated.workItem.failureMessage).toBeNull()
            expect(investigated.workItem.holdsWorkerSlot).toBe(false)
            const investigateRun = investigated.workItem.stepRuns.find(
              (run) => run.step === "investigate_pr_status_checks",
            )
            expect(investigateRun?.status).toBe("failed")
            expect(investigateRun?.reasonCode).toBe(
              STEP_RUN_REASON.prStatusChecksUnresolved,
            )
            expect(investigateRun?.reasonMessage).toBe(failureMessage)
          }

          const checks = (yield* sql.unsafe(
            `SELECT handled_at FROM pr_status_check WHERE id = ?`,
            [checkId],
          )) as readonly { readonly handled_at: number | null }[]
          expect(checks[0]?.handled_at).toBeNull()

          const jobs = (yield* sql.unsafe(
            `SELECT id FROM job_queue WHERE job_attempts < job_retry_limit`,
          )) as readonly { readonly id: string }[]
          expect(jobs).toHaveLength(0)

          const final = yield* lifecycle.getWorkItem(created.id)
          expect(final.state).toBe("investigate_pr_status_checks")
          expect(final.failureCode).toBeNull()
        }),
      )
    })

    it("fails retryably at the Check-Start Deadline when aggregate stays failed with no unhandled execution", () => {
      const anchorInstant = 1_008_000
      const tags = ["failed", "failed", "succeeded"] as const
      let statusIndex = 0
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        watchPrStatusChecks: () => {
          const tag = tags[statusIndex++] ?? "failed"
          if (tag === "succeeded") {
            return Effect.succeed(watchResult("succeeded"))
          }
          return Effect.succeed({
            _tag: tag,
            createdAt: new Date(anchorInstant),
            headSha: "failed-head",
            headPushedAt: new Date(anchorInstant),
            isDraft: false,
          })
        },
      }

      return Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              yield* TestClock.setTime(1_000_000)
              const sql = yield* SqlClient.SqlClient
              const lifecycle = yield* WorkItemLifecycle
              const { repository, issue } = yield* seedActionableIssue
              const created = yield* lifecycle.implementNow(
                repository.id,
                issue.githubIssueNumber,
              )

              for (let index = 0; index < 8; index += 1) {
                yield* TestClock.adjust(1_000)
                yield* claimAndRunPending
              }
              yield* forgetCreatePrDraftProvenance(created.id)

              // First failed poll establishes the anchor and requeues until deadline.
              yield* TestClock.setTime(anchorInstant)
              const beforeDeadline = yield* claimAndRunPending
              expect(beforeDeadline._tag).toBe("processed")
              if (beforeDeadline._tag === "processed") {
                expect(beforeDeadline.workItem.state).toBe(
                  "watch_pr_status_checks",
                )
              }

              const delayed = (yield* sql.unsafe(
                `SELECT available_at, created_at FROM job_queue`,
              )) as readonly {
                readonly available_at: number
                readonly created_at: number
              }[]
              expect(delayed).toHaveLength(1)
              expect(delayed[0]!.available_at - delayed[0]!.created_at).toBe(
                30_000,
              )

              yield* TestClock.setTime(anchorInstant + CHECK_START_DEADLINE_MS)
              yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
              const stopped = yield* claimAndRunPending
              expect(stopped._tag).toBe("processed")
              if (stopped._tag === "processed") {
                expect(stopped.workItem.state).toBe("watch_pr_status_checks")
                expect(stopped.workItem.failureCode).toBeNull()
                expect(stopped.workItem.failureMessage).toBeNull()
                expect(stopped.workItem.holdsWorkerSlot).toBe(false)
                expect(stopped.workItem.stepRuns.at(-1)?.status).toBe("failed")
                expect(stopped.workItem.stepRuns.at(-1)?.reasonCode).toBe(
                  STEP_RUN_REASON.prStatusChecksUnresolved,
                )
                expect(
                  stopped.workItem.stepRuns.at(-1)?.reasonMessage,
                ).toContain(
                  "fix or rerun the checks on GitHub, then click Retry checks",
                )
              }

              const jobs = (yield* sql.unsafe(
                `SELECT id FROM job_queue WHERE job_attempts < job_retry_limit`,
              )) as readonly { readonly id: string }[]
              expect(jobs).toHaveLength(0)

              const retried = yield* lifecycle.retry(created.id)
              expect(retried.state).toBe("watch_pr_status_checks")
              expect(retried.stepRuns.at(-1)?.status).toBe("queued")

              yield* TestClock.adjust(1_000)
              const ready = yield* claimAndRunPending
              expect(ready._tag).toBe("processed")
              if (ready._tag === "processed") {
                expect(ready.workItem.state).toBe("decide_pr_merge")
              }
            }),
            makeTestLayer(steps).pipe(Layer.provideMerge(TestClock.layer())),
          ),
        ),
      )
    })

    it("keeps a pre-recorded Check-Start Anchor after CHECKS_TRIGGERED with checkStartAnchorRecorded", () => {
      const checkId = "psc-authorized-rerun"
      const priorAnchorAt = 2_000
      const triggerAt = 70_000
      const investigateAt = 80_000
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        watchPrStatusChecks: () =>
          Effect.succeed(watchResult("handoff_needed")),
        investigatePrStatusChecks: () =>
          Effect.succeed({
            _tag: "checks_triggered" as const,
            handledCheckIds: [checkId],
            // Simulates authorized review rerun that already wrote the anchor.
            checkStartAnchorRecorded: true,
          }),
      }

      return Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              yield* TestClock.setTime(0)
              const sql = yield* SqlClient.SqlClient
              const lifecycle = yield* WorkItemLifecycle
              const { repository, issue } = yield* seedActionableIssue
              const created = yield* lifecycle.implementNow(
                repository.id,
                issue.githubIssueNumber,
              )

              for (let index = 0; index < 8; index += 1) {
                yield* claimAndRunPending
              }
              yield* forgetCreatePrDraftProvenance(created.id)

              const handoff = yield* claimAndRunPending
              expect(handoff._tag).toBe("processed")
              if (handoff._tag === "processed") {
                expect(handoff.workItem.state).toBe(
                  "investigate_pr_status_checks",
                )
              }

              yield* TestClock.setTime(investigateAt)
              yield* sql.unsafe(
                `UPDATE work_item
                 SET check_start_anchor_at = ?,
                     check_start_anchor_head_sha = 'rerun-head',
                     updated_at = ?
                 WHERE id = ?`,
                [triggerAt, investigateAt, created.id],
              )
              yield* sql.unsafe(
                `INSERT INTO pr_status_check (
                   id, work_item_id, external_id, name, outcome,
                   handled_at, observed_at, created_at, updated_at
                 ) VALUES (?, ?, 'actions-job:review-rerun', 'review', 'green', NULL, ?, ?, ?)`,
                [
                  checkId,
                  created.id,
                  investigateAt,
                  investigateAt,
                  investigateAt,
                ],
              )

              const afterInvestigate = yield* claimAndRunPending
              expect(afterInvestigate._tag).toBe("processed")
              if (afterInvestigate._tag === "processed") {
                expect(afterInvestigate.workItem.state).toBe(
                  "watch_pr_status_checks",
                )
              }

              const delayed = (yield* sql.unsafe(
                `SELECT available_at, created_at FROM job_queue`,
              )) as readonly {
                readonly available_at: number
                readonly created_at: number
              }[]
              expect(delayed).toHaveLength(1)
              expect(delayed[0]!.available_at - delayed[0]!.created_at).toBe(
                30_000,
              )

              const anchors = (yield* sql.unsafe(
                `SELECT check_start_anchor_at, check_start_anchor_head_sha
                 FROM work_item WHERE id = ?`,
                [created.id],
              )) as readonly {
                readonly check_start_anchor_at: number | null
                readonly check_start_anchor_head_sha: string | null
              }[]
              // Must retain the trigger-time anchor, not step-completion time.
              expect(anchors[0]?.check_start_anchor_at).toBe(triggerAt)
              expect(anchors[0]?.check_start_anchor_head_sha).toBe("rerun-head")
              expect(anchors[0]?.check_start_anchor_at).not.toBe(investigateAt)
              expect(anchors[0]?.check_start_anchor_at).not.toBe(priorAnchorAt)
            }),
            makeTestLayer(steps).pipe(Layer.provideMerge(TestClock.layer())),
          ),
        ),
      )
    })

    it("stops polling when the PR is closed without merging", () => {
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        watchPrStatusChecks: () => Effect.succeed(watchResult("closed")),
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
          for (let index = 0; index < 9; index += 1) {
            yield* claimAndRunPending
          }

          const final = yield* lifecycle.getWorkItem(created.id)
          expect(final.state).toBe("needs_human")
          expect(final.failureMessage).toBe(
            "The pull request was closed before its status checks succeeded",
          )
        }),
      )
    })

    it("supplies worktree path, session, model, and variant to later handlers", () => {
      const seen: LifecycleStepContext[] = []
      const recordingSteps: LifecycleStepsShape = {
        createWorktree: (context) => {
          seen.push(context)
          return Effect.succeed({
            worktreePath: "/tmp/worktrees/recorded",
            startingCommitOid: "abc123",
          })
        },
        installDependencies: (context) => {
          seen.push(context)
          return Effect.void
        },
        implement: (context) => {
          seen.push(context)
          return Effect.succeed("ses_recorded")
        },
        assessChanges: (context) => {
          seen.push(context)
          return Effect.succeed({ _tag: "changes" as const })
        },
        preCommit: (context) => {
          seen.push(context)
          return Effect.void
        },
        review: (context) => {
          seen.push(context)
          return Effect.succeed({ _tag: "clean" as const })
        },
        commit: (context) => {
          seen.push(context)
          return Effect.void
        },
        createPr: (context) => {
          seen.push(context)
          return Effect.succeed(101)
        },
        watchPrStatusChecks: (context) => {
          seen.push(context)
          return Effect.succeed(watchResult("succeeded"))
        },
        resolvePrMergeConflict: () => Effect.succeed({ _tag: "processed" }),
        investigatePrStatusChecks: () =>
          Effect.succeed({ _tag: "processed", handledCheckIds: [] }),
        markPrReadyForReview: (context) => {
          seen.push(context)
          return Effect.void
        },
        decidePrMerge: (context) => {
          seen.push(context)
          return Effect.succeed({ _tag: "clanker_merge" })
        },
        mergePr: (context) => {
          seen.push(context)
          return Effect.succeed({ _tag: "merged" as const })
        },
        closeIssue: () => Effect.void,
        localCleanup: (context) => {
          seen.push(context)
          return Effect.void
        },
        removeWorktree: () => Effect.void,
      }

      return runWithSteps(
        recordingSteps,
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const db = yield* DbService
          const { repository, issue } = yield* seedActionableIssue

          yield* db.updateConfig({
            selectedAgentBackend: "opencode",
            defaultModel: "anthropic/claude-sonnet-4-5",
            defaultThinkingLevel: "high",
            reviewModel: null,
            reviewThinkingLevel: null,
            maxConcurrentAgentTurns: 2,
            maxConcurrentWorkItems: 5,
          })

          yield* lifecycle.implementNow(repository.id, issue.githubIssueNumber)
          const wi = yield* lifecycle.listWorkItemsForIssue(
            repository.id,
            issue.githubIssueNumber,
          )
          const workItemId = wi[0]!.id
          yield* driveThroughCreatePrAlreadyReady(workItemId)
          for (let index = 0; index < 4; index += 1) {
            yield* makeQueuedJobsAvailable
            yield* claimAndRunPending
          }

          // Mark Ready is skipped when the PR snapshot is already ready.
          expect(seen).toHaveLength(12)
          expect(seen[0]!.worktreePath).toBeNull()
          expect(seen[0]!.sessionId).toBeNull()
          expect(seen[0]!.model).toBe("anthropic/claude-sonnet-4-5")
          expect(seen[0]!.thinkingLevel).toBe("high")

          expect(seen[1]!.worktreePath).toBe("/tmp/worktrees/recorded")
          expect(seen[1]!.sessionId).toBeNull()

          expect(seen[2]!.worktreePath).toBe("/tmp/worktrees/recorded")
          expect(seen[2]!.sessionId).toBeNull()
          expect(seen[2]!.model).toBe("anthropic/claude-sonnet-4-5")
          expect(seen[2]!.thinkingLevel).toBe("high")

          expect(seen[3]!.worktreePath).toBe("/tmp/worktrees/recorded")
          expect(seen[3]!.startingCommitOid).toBe("abc123")
          expect(seen[3]!.sessionId).toBe("ses_recorded")
          expect(seen[3]!.model).toBe("anthropic/claude-sonnet-4-5")
          expect(seen[3]!.thinkingLevel).toBe("high")

          expect(seen[4]!.worktreePath).toBe("/tmp/worktrees/recorded")
          expect(seen[4]!.sessionId).toBe("ses_recorded")
          expect(seen[4]!.model).toBe("anthropic/claude-sonnet-4-5")
          expect(seen[4]!.thinkingLevel).toBe("high")

          expect(seen[5]!.worktreePath).toBe("/tmp/worktrees/recorded")
          expect(seen[5]!.sessionId).toBe("ses_recorded")
          expect(seen[5]!.model).toBe("anthropic/claude-sonnet-4-5")
          expect(seen[5]!.thinkingLevel).toBe("high")

          expect(seen[6]!.worktreePath).toBe("/tmp/worktrees/recorded")
          expect(seen[6]!.sessionId).toBe("ses_recorded")
          expect(seen[6]!.model).toBe("anthropic/claude-sonnet-4-5")
          expect(seen[6]!.thinkingLevel).toBe("high")
          expect(seen[7]!.worktreePath).toBe("/tmp/worktrees/recorded")
          expect(seen[7]!.sessionId).toBe("ses_recorded")
          expect(seen[8]!.worktreePath).toBe("/tmp/worktrees/recorded")
          expect(seen[8]!.sessionId).toBe("ses_recorded")
          expect(seen[9]!.worktreePath).toBe("/tmp/worktrees/recorded")
          expect(seen[9]!.sessionId).toBe("ses_recorded")
          expect(seen[10]!.worktreePath).toBe("/tmp/worktrees/recorded")
          expect(seen[10]!.sessionId).toBe("ses_recorded")
          expect(seen[11]!.worktreePath).toBe("/tmp/worktrees/recorded")
          expect(seen[11]!.sessionId).toBe("ses_recorded")
        }),
      )
    })

    it("uses freshly resolved models on the next turn after settings change", () => {
      const seen: LifecycleStepContext[] = []
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        createWorktree: (context) => {
          seen.push(context)
          return Effect.succeed({
            worktreePath: "/tmp/worktrees/model-switch",
            startingCommitOid: "abc123",
          })
        },
        installDependencies: (context) => {
          seen.push(context)
          return Effect.void
        },
        implement: (context) => {
          seen.push(context)
          return Effect.succeed("ses_model_switch")
        },
      }

      return runWithSteps(
        steps,
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const db = yield* DbService
          const { repository, issue } = yield* seedActionableIssue

          yield* db.updateConfig({
            selectedAgentBackend: "opencode",
            defaultModel: "anthropic/claude-sonnet-4-5",
            defaultThinkingLevel: "high",
            reviewModel: "anthropic/claude-opus-4-6",
            reviewThinkingLevel: "max",
            maxConcurrentAgentTurns: 2,
            maxConcurrentWorkItems: 5,
          })

          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )

          yield* claimAndRunPending
          expect(seen).toHaveLength(1)
          expect(seen[0]!.model).toBe("anthropic/claude-sonnet-4-5")
          expect(seen[0]!.thinkingLevel).toBe("high")
          expect(seen[0]!.reviewModel).toBe("anthropic/claude-opus-4-6")
          expect(seen[0]!.reviewThinkingLevel).toBe("max")

          yield* db.updateConfig({
            selectedAgentBackend: "opencode",
            defaultModel: "opencode/gpt-5",
            defaultThinkingLevel: "low",
            reviewModel: "opencode/gpt-5-pro",
            reviewThinkingLevel: "medium",
            maxConcurrentAgentTurns: 2,
            maxConcurrentWorkItems: 5,
          })

          yield* claimAndRunPending
          expect(seen).toHaveLength(2)
          expect(seen[1]!.model).toBe("opencode/gpt-5")
          expect(seen[1]!.thinkingLevel).toBe("low")
          expect(seen[1]!.reviewModel).toBe("opencode/gpt-5-pro")
          expect(seen[1]!.reviewThinkingLevel).toBe("medium")

          yield* db.updateRepositorySettings({
            repositoryId: repository.id,
            paused: repository.paused,
            defaultModel: "anthropic/claude-haiku-4-5",
            defaultThinkingLevel: "max",
            reviewModel: null,
            reviewThinkingLevel: null,
            autoMerge: repository.autoMerge,
            includeAllIssueAuthors: repository.includeAllIssueAuthors,
          })

          yield* claimAndRunPending
          expect(seen).toHaveLength(3)
          expect(seen[2]!.model).toBe("anthropic/claude-haiku-4-5")
          expect(seen[2]!.thinkingLevel).toBe("max")
          expect(seen[2]!.reviewModel).toBe("opencode/gpt-5-pro")
          expect(seen[2]!.reviewThinkingLevel).toBe("medium")

          const workItem = yield* lifecycle.getWorkItem(created.id)
          expect(workItem.state).toBe("assess_changes")
          expect(workItem.sessionId).toBe("ses_model_switch")
        }),
      )
    })

    it("hands high-risk merge decisions to a human", () => {
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        decidePrMerge: () =>
          Effect.succeed({
            _tag: "needs_human",
            reason: "Touches authentication secrets",
          }),
        mergePr: () => Effect.die("merge must not run after needs_human"),
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
          yield* driveThroughCreatePrAlreadyReady(created.id)
          for (let index = 0; index < 2; index += 1) {
            yield* makeQueuedJobsAvailable
            yield* claimAndRunPending
          }

          const final = yield* lifecycle.getWorkItem(created.id)
          expect(final.state).toBe("needs_human")
          expect(final.failureCode).toBe("needs_human")
          expect(final.failureMessage).toBe("Touches authentication secrets")
        }),
      )
    })

    it("resumes local cleanup after human merge of a Decide PR Merge handoff", () => {
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        decidePrMerge: () =>
          Effect.succeed({
            _tag: "needs_human",
            reason: "Auto-merge is disabled for this repository",
          }),
        mergePr: () =>
          Effect.die("merge must not run after human merge resume"),
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
          yield* driveThroughCreatePrAlreadyReady(created.id)
          for (let index = 0; index < 2; index += 1) {
            yield* makeQueuedJobsAvailable
            yield* claimAndRunPending
          }

          const needsHuman = yield* lifecycle.getWorkItem(created.id)
          expect(needsHuman.state).toBe("needs_human")

          const resumed = yield* lifecycle.continueAfterHumanPrOutcome(
            created.id,
            "merged",
          )
          expect(resumed.state).toBe("local_cleanup")
          expect(resumed.failureCode).toBeNull()
          expect(resumed.failureMessage).toBeNull()

          yield* makeQueuedJobsAvailable
          const afterCleanup = yield* claimAndRunPending
          expect(afterCleanup._tag).toBe("processed")
          if (afterCleanup._tag === "processed") {
            expect(afterCleanup.workItem.state).toBe("complete")
            expect(afterCleanup.workItem.worktreePath).toBeNull()
            expect(
              afterCleanup.workItem.stepRuns.map((run) => [
                run.step,
                run.status,
              ]),
            ).toContainEqual(["local_cleanup", "succeeded"])
            expect(
              afterCleanup.workItem.stepRuns.some(
                (run) => run.step === "merge_pr",
              ),
            ).toBe(false)
          }
        }),
      )
    })

    it("abandons a Decide PR Merge handoff after cleanup when the PR is closed unmerged", () => {
      let cleanupCalls = 0
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        decidePrMerge: () =>
          Effect.succeed({
            _tag: "needs_human",
            reason: "Auto-merge is disabled for this repository",
          }),
        localCleanup: () => {
          cleanupCalls += 1
          return Effect.void
        },
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
          yield* driveThroughCreatePrAlreadyReady(created.id)
          for (let index = 0; index < 2; index += 1) {
            yield* makeQueuedJobsAvailable
            yield* claimAndRunPending
          }

          const abandoned = yield* lifecycle.continueAfterHumanPrOutcome(
            created.id,
            "closed_unmerged",
          )
          expect(abandoned.state).toBe("abandoned")
          expect(abandoned.failureCode).toBeNull()
          expect(abandoned.worktreePath).toBeNull()
          expect(cleanupCalls).toBe(1)
        }),
      )
    })

    it("stays Needs Human when abandon cleanup fails", () => {
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        decidePrMerge: () =>
          Effect.succeed({
            _tag: "needs_human",
            reason: "Auto-merge is disabled for this repository",
          }),
        localCleanup: () =>
          Effect.fail(
            new LifecycleStepFailedError({ message: "worktree locked" }),
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
          yield* driveThroughCreatePrAlreadyReady(created.id)
          for (let index = 0; index < 2; index += 1) {
            yield* makeQueuedJobsAvailable
            yield* claimAndRunPending
          }

          const result = yield* lifecycle
            .continueAfterHumanPrOutcome(created.id, "closed_unmerged")
            .pipe(Effect.result)
          expect(Result.isFailure(result)).toBe(true)

          const stillNeedsHuman = yield* lifecycle.getWorkItem(created.id)
          expect(stillNeedsHuman.state).toBe("needs_human")
          expect(stillNeedsHuman.failureMessage).toBe(
            "Auto-merge is disabled for this repository",
          )
        }),
      )
    })

    it("blocks Implement Now while a Needs Human Work Item exists", () => {
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        decidePrMerge: () =>
          Effect.succeed({
            _tag: "needs_human",
            reason: "Auto-merge is disabled for this repository",
          }),
      }

      return runWithSteps(
        steps,
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const { repository, issue } = yield* seedActionableIssue
          yield* lifecycle.implementNow(repository.id, issue.githubIssueNumber)
          for (let index = 0; index < 10; index += 1) {
            yield* makeQueuedJobsAvailable
            yield* claimAndRunPending
          }

          const blocked = yield* Effect.flip(
            lifecycle.implementNow(repository.id, issue.githubIssueNumber),
          )
          expect(blocked).toBeInstanceOf(UnfinishedWorkItemExistsError)
        }),
      )
    })

    it("allows operator Abandon from Needs Human after local cleanup", () => {
      let cleanupCalls = 0
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        decidePrMerge: () =>
          Effect.succeed({
            _tag: "needs_human",
            reason: "Touches authentication secrets",
          }),
        localCleanup: () => {
          cleanupCalls += 1
          return Effect.void
        },
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
          yield* driveThroughCreatePrAlreadyReady(created.id)
          for (let index = 0; index < 2; index += 1) {
            yield* makeQueuedJobsAvailable
            yield* claimAndRunPending
          }

          const abandoned = yield* lifecycle.abandon(created.id)
          expect(abandoned.state).toBe("abandoned")
          expect(abandoned.worktreePath).toBeNull()
          expect(cleanupCalls).toBe(1)
        }),
      )
    })

    it("advances to Commit when Review reports clean", () => {
      let reviewCalls = 0
      const stepsCleanReview: LifecycleStepsShape = {
        ...successfulSteps,
        review: () => {
          reviewCalls += 1
          return Effect.succeed({ _tag: "clean" as const })
        },
      }

      return runWithSteps(
        stepsCleanReview,
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const { repository, issue } = yield* seedActionableIssue
          yield* lifecycle.implementNow(repository.id, issue.githubIssueNumber)
          yield* claimAndRunPending
          yield* claimAndRunPending
          yield* claimAndRunPending
          yield* claimAndRunPending
          yield* claimAndRunPending
          const afterReview = yield* claimAndRunPending

          expect(reviewCalls).toBe(1)
          expect(afterReview._tag).toBe("processed")
          if (afterReview._tag === "processed") {
            expect(afterReview.workItem.state).toBe("commit")
          }
        }),
      )
    })

    it("advances to Commit when Review reports deferred findings", () => {
      const stepsDeferredReview: LifecycleStepsShape = {
        ...successfulSteps,
        review: () =>
          Effect.succeed({
            _tag: "deferred" as const,
            severity: "low" as const,
            reason: "style nits only",
          }),
      }

      return runWithSteps(
        stepsDeferredReview,
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const { repository, issue } = yield* seedActionableIssue
          yield* lifecycle.implementNow(repository.id, issue.githubIssueNumber)
          yield* claimAndRunPending
          yield* claimAndRunPending
          yield* claimAndRunPending
          yield* claimAndRunPending
          yield* claimAndRunPending
          const afterReview = yield* claimAndRunPending

          expect(afterReview._tag).toBe("processed")
          if (afterReview._tag === "processed") {
            expect(afterReview.workItem.state).toBe("commit")
            const reviewRun = afterReview.workItem.stepRuns.find(
              (run) => run.step === "review",
            )
            expect(reviewRun?.status).toBe("succeeded")
            expect(reviewRun?.reasonCode).toBe(STEP_RUN_REASON.reviewDeferred)
            expect(reviewRun?.reasonMessage).toBe("low: style nits only")
          }
        }),
      )
    })

    it("advances to Commit when Review reports cleared findings", () => {
      const stepsClearedReview: LifecycleStepsShape = {
        ...successfulSteps,
        review: () =>
          Effect.succeed({
            _tag: "cleared" as const,
            reason: "false positive on import order",
          }),
      }

      return runWithSteps(
        stepsClearedReview,
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const { repository, issue } = yield* seedActionableIssue
          yield* lifecycle.implementNow(repository.id, issue.githubIssueNumber)
          yield* claimAndRunPending
          yield* claimAndRunPending
          yield* claimAndRunPending
          yield* claimAndRunPending
          yield* claimAndRunPending
          const afterReview = yield* claimAndRunPending

          expect(afterReview._tag).toBe("processed")
          if (afterReview._tag === "processed") {
            expect(afterReview.workItem.state).toBe("commit")
            const reviewRun = afterReview.workItem.stepRuns.find(
              (run) => run.step === "review",
            )
            expect(reviewRun?.status).toBe("succeeded")
            expect(reviewRun?.reasonCode).toBe(STEP_RUN_REASON.reviewCleared)
            expect(reviewRun?.reasonMessage).toBe(
              "false positive on import order",
            )
          }
        }),
      )
    })

    it("advances to Commit when Review reports accepted low-severity remediation", () => {
      const stepsAcceptedReview: LifecycleStepsShape = {
        ...successfulSteps,
        review: () =>
          Effect.succeed({
            _tag: "accepted" as const,
            reason: "direct localized rename",
            deferred: {
              severity: "low" as const,
              reason: "style nits remain",
            },
          }),
      }

      return runWithSteps(
        stepsAcceptedReview,
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const { repository, issue } = yield* seedActionableIssue
          yield* lifecycle.implementNow(repository.id, issue.githubIssueNumber)
          yield* claimAndRunPending
          yield* claimAndRunPending
          yield* claimAndRunPending
          yield* claimAndRunPending
          yield* claimAndRunPending
          const afterReview = yield* claimAndRunPending

          expect(afterReview._tag).toBe("processed")
          if (afterReview._tag === "processed") {
            expect(afterReview.workItem.state).toBe("commit")
            const reviewRun = afterReview.workItem.stepRuns.find(
              (run) => run.step === "review",
            )
            expect(reviewRun?.status).toBe("succeeded")
            expect(reviewRun?.reasonCode).toBe(STEP_RUN_REASON.reviewAccepted)
            expect(reviewRun?.reasonMessage).toBe(
              "direct localized rename (deferred low: style nits remain)",
            )
          }
        }),
      )
    })

    it("enters Needs Human when Review reports unresolved high and releases the Worker Slot", () => {
      const reason = "auth bypass remains open"
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        review: () =>
          Effect.succeed({
            _tag: "needs_human" as const,
            reason,
          }),
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
          yield* claimAndRunPending
          yield* claimAndRunPending
          yield* claimAndRunPending
          yield* claimAndRunPending
          const afterReview = yield* claimAndRunPending

          expect(afterReview._tag).toBe("processed")
          if (afterReview._tag === "processed") {
            expect(afterReview.workItem.state).toBe("needs_human")
            expect(afterReview.workItem.failureCode).toBe("needs_human")
            expect(afterReview.workItem.failureMessage).toBe(reason)
            expect(afterReview.workItem.holdsWorkerSlot).toBe(false)
          }

          const final = yield* lifecycle.getWorkItem(created.id)
          expect(final.state).toBe("needs_human")
          expect(final.holdsWorkerSlot).toBe(false)
        }),
      )
    })

    it("enters Needs Human when Review exhausts fix rounds and releases the Worker Slot", () => {
      const reason = REVIEW_FIX_LIMIT_REASON
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        review: () =>
          Effect.succeed({
            _tag: "needs_human" as const,
            reason,
          }),
      }

      return runWithSteps(
        steps,
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const sql = yield* SqlClient.SqlClient
          const { repository, issue } = yield* seedActionableIssue
          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          yield* claimAndRunPending
          yield* claimAndRunPending
          yield* claimAndRunPending
          yield* claimAndRunPending
          yield* claimAndRunPending
          const afterReview = yield* claimAndRunPending

          expect(afterReview._tag).toBe("processed")
          if (afterReview._tag === "processed") {
            expect(afterReview.workItem.state).toBe("needs_human")
            expect(afterReview.workItem.failureCode).toBe("needs_human")
            expect(afterReview.workItem.failureMessage).toBe(reason)
            expect(afterReview.workItem.holdsWorkerSlot).toBe(false)
            expect(afterReview.workItem.sessionId).toBe(
              "ses_test_implement_session",
            )
            const reviewRun = afterReview.workItem.stepRuns.at(-1)
            expect(reviewRun?.step).toBe("review")
            expect(reviewRun?.status).toBe("succeeded")
          }

          const queued = (yield* sql.unsafe(
            `SELECT COUNT(*) AS count FROM job_queue`,
          )) as readonly { count: number }[]
          expect(Number(queued[0]?.count)).toBe(0)

          const blocked = yield* Effect.flip(
            lifecycle.implementNow(repository.id, issue.githubIssueNumber),
          )
          expect(blocked).toBeInstanceOf(UnfinishedWorkItemExistsError)

          const final = yield* lifecycle.getWorkItem(created.id)
          expect(final.state).toBe("needs_human")
          expect(final.holdsWorkerSlot).toBe(false)
        }),
      )
    })

    it("retries Review fix-limit Needs Human at a fresh reviewing pass", () => {
      const reason = REVIEW_FIX_LIMIT_REASON
      let reviewCalls = 0
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        review: () => {
          reviewCalls += 1
          if (reviewCalls === 1) {
            return Effect.succeed({
              _tag: "needs_human" as const,
              reason,
            })
          }
          return Effect.succeed({ _tag: "clean" as const })
        },
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
          yield* claimAndRunPending
          yield* claimAndRunPending
          yield* claimAndRunPending
          yield* claimAndRunPending
          const afterReview = yield* claimAndRunPending
          expect(afterReview._tag).toBe("processed")
          if (afterReview._tag === "processed") {
            expect(afterReview.workItem.state).toBe("needs_human")
            expect(afterReview.workItem.holdsWorkerSlot).toBe(false)
          }

          const retried = yield* lifecycle.retry(created.id)
          expect(retried.state).toBe("review")
          expect(retried.failureCode).toBeNull()
          expect(retried.failureMessage).toBeNull()
          expect(retried.holdsWorkerSlot).toBe(true)
          expect(retried.sessionId).toBe("ses_test_implement_session")
          expect(retried.stepRuns.at(-1)).toMatchObject({
            step: "review",
            status: "queued",
          })

          const secondReview = yield* claimAndRunPending
          expect(reviewCalls).toBe(2)
          expect(secondReview._tag).toBe("processed")
          if (secondReview._tag === "processed") {
            expect(secondReview.workItem.state).toBe("commit")
            expect(secondReview.workItem.failureCode).toBeNull()
            expect(secondReview.workItem.failureMessage).toBeNull()
          }
        }),
      )
    })

    it("persists complete pre-commit hook output on failure", () => {
      const output = `format failed: ${"x".repeat(9_000)}`
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        preCommit: (context) =>
          Effect.fail(
            new PreCommitHookFailedError({
              message: "Pre-commit validation failed (exit 1)",
              worktreePath: context.worktreePath!,
              exitCode: 1,
              output,
            }),
          ),
      }

      return runWithSteps(
        steps,
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const { repository, issue } = yield* seedActionableIssue
          yield* lifecycle.implementNow(repository.id, issue.githubIssueNumber)
          yield* claimAndRunPending
          yield* claimAndRunPending
          yield* claimAndRunPending
          yield* claimAndRunPending
          const result = yield* claimAndRunPending

          expect(result._tag).toBe("processed")
          if (result._tag === "processed") {
            expect(result.workItem.state).toBe("pre_commit")
            const failedRun = result.workItem.stepRuns.at(-1)!
            expect(failedRun.status).toBe("failed")
            expect(failedRun.reasonMessage).toBe(
              `Pre-commit validation failed (exit 1)\n${output}`,
            )
          }
        }),
      )
    })

    it("persists commit OpenCode failure message", () => {
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        commit: () =>
          Effect.fail(
            new CommitOpenCodeError({
              message: "OpenCode failed to commit the Work Item changes",
              worktreePath: "/tmp/worktrees/acme-widgets-42",
              sessionId: "ses_test_implement_session",
            }),
          ),
      }

      return runWithSteps(
        steps,
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const { repository, issue } = yield* seedActionableIssue
          yield* lifecycle.implementNow(repository.id, issue.githubIssueNumber)
          yield* claimAndRunPending
          yield* claimAndRunPending
          yield* claimAndRunPending
          yield* claimAndRunPending
          yield* claimAndRunPending
          yield* claimAndRunPending
          const result = yield* claimAndRunPending

          expect(result._tag).toBe("processed")
          if (result._tag === "processed") {
            expect(result.workItem.state).toBe("commit")
            const failedRun = result.workItem.stepRuns.at(-1)!
            expect(failedRun.status).toBe("failed")
            expect(failedRun.reasonMessage).toBe(
              "OpenCode failed to commit the Work Item changes",
            )
          }
        }),
      )
    })

    it("persists create PR OpenCode failure message", () => {
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        createPr: () =>
          Effect.fail(
            new CreatePrOpenCodeError({
              message: "OpenCode failed to create a pull request",
              worktreePath: "/tmp/worktrees/acme-widgets-42",
              sessionId: "ses_test_implement_session",
            }),
          ),
      }

      return runWithSteps(
        steps,
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const { repository, issue } = yield* seedActionableIssue
          yield* lifecycle.implementNow(repository.id, issue.githubIssueNumber)
          yield* claimAndRunPending
          yield* claimAndRunPending
          yield* claimAndRunPending
          yield* claimAndRunPending
          yield* claimAndRunPending
          yield* claimAndRunPending
          yield* claimAndRunPending
          const result = yield* claimAndRunPending

          expect(result._tag).toBe("processed")
          if (result._tag === "processed") {
            expect(result.workItem.state).toBe("create_pr")
            const failedRun = result.workItem.stepRuns.at(-1)!
            expect(failedRun.status).toBe("failed")
            expect(failedRun.reasonMessage).toBe(
              "OpenCode failed to create a pull request",
            )
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
          return Effect.succeed({
            worktreePath: "/tmp/worktrees/deleted-issue",
            startingCommitOid: "abc123",
          })
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

    it("fails the Work Item terminally on Close Issue eligibility errors", () => {
      const cases = [
        {
          name: "missing",
          failureCode: "issue_not_found",
          message: "Issue #42 is no longer present in the Issue store",
        },
        {
          name: "parent",
          failureCode: "issue_is_parent",
          message: "Issue #42 has children and is no longer a Leaf Issue",
        },
        {
          name: "blocked",
          failureCode: "issue_blocked",
          message: "Issue #42 is blocked by 1 Issue(s)",
        },
      ] as const

      return Effect.runPromise(
        Effect.gen(function* () {
          for (const testCase of cases) {
            const steps: LifecycleStepsShape = {
              ...successfulSteps,
              assessChanges: () =>
                Effect.succeed({
                  _tag: "no_changes",
                  completionSummary: "Done without file changes",
                }),
              closeIssue: () =>
                Effect.fail(
                  new CloseIssueEligibilityError({
                    workItemId: "unused",
                    failureCode: testCase.failureCode,
                    message: testCase.message,
                  }),
                ),
            }

            yield* Effect.gen(function* () {
              const lifecycle = yield* WorkItemLifecycle
              const { repository, issue } = yield* seedActionableIssue
              const created = yield* lifecycle.implementNow(
                repository.id,
                issue.githubIssueNumber,
              )
              yield* claimAndRunPending
              yield* claimAndRunPending
              yield* claimAndRunPending
              const afterAssess = yield* claimAndRunPending
              expect(afterAssess._tag).toBe("processed")
              if (afterAssess._tag !== "processed") {
                return
              }
              expect(afterAssess.workItem.state).toBe("close_issue")

              const failedClose = yield* claimAndRunPending
              expect(failedClose._tag).toBe("processed")
              if (failedClose._tag !== "processed") {
                return
              }
              expect(failedClose.workItem.state).toBe("failed")
              expect(failedClose.workItem.failureCode).toBe(
                testCase.failureCode,
              )
              expect(failedClose.workItem.failureMessage).toBe(testCase.message)
              expect(isTerminalWorkItemState(failedClose.workItem.state)).toBe(
                true,
              )
              expect(failedClose.workItem.holdsWorkerSlot).toBe(false)
              const closeRun = failedClose.workItem.stepRuns.at(-1)!
              expect(closeRun.step).toBe("close_issue")
              expect(closeRun.status).toBe("failed")
              expect(closeRun.reasonCode).toBe(testCase.failureCode)
              expect(closeRun.reasonMessage).toBe(testCase.message)

              const listed = [afterAssess.workItem, failedClose.workItem]
              expect(
                filterWorkItemsByListKind(listed, "working").map(
                  (item) => item.state,
                ),
              ).toEqual(["close_issue"])
              expect(
                filterWorkItemsByListKind(listed, "failed").map(
                  (item) => item.state,
                ),
              ).toEqual(["failed"])
              expect(
                filterWorkItemsByListKind(listed, "completed").map(
                  (item) => item.state,
                ),
              ).toEqual([])

              const retryError = yield* Effect.flip(lifecycle.retry(created.id))
              expect(retryError).toBeInstanceOf(WorkItemTerminalError)
            }).pipe(Effect.provide(makeTestLayer(steps)))
          }
        }),
      )
    })

    it("keeps Close Issue retriable for non-eligibility handler failures", () => {
      let closeAttempts = 0
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        assessChanges: () =>
          Effect.succeed({
            _tag: "no_changes",
            completionSummary: "Done without file changes",
          }),
        closeIssue: () =>
          Effect.gen(function* () {
            closeAttempts += 1
            if (closeAttempts === 1) {
              return yield* Effect.fail(
                new LifecycleStepFailedError({
                  message: "GitHub temporary failure",
                }),
              )
            }
          }),
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
          yield* claimAndRunPending
          yield* claimAndRunPending
          const afterAssess = yield* claimAndRunPending
          expect(afterAssess._tag).toBe("processed")
          if (afterAssess._tag !== "processed") {
            return
          }
          expect(afterAssess.workItem.state).toBe("close_issue")

          const failedClose = yield* claimAndRunPending
          expect(failedClose._tag).toBe("processed")
          if (failedClose._tag !== "processed") {
            return
          }
          expect(failedClose.workItem.state).toBe("close_issue")
          expect(failedClose.workItem.failureCode).toBeNull()
          expect(isTerminalWorkItemState(failedClose.workItem.state)).toBe(
            false,
          )
          expect(failedClose.workItem.stepRuns.at(-1)?.status).toBe("failed")
          expect(failedClose.workItem.stepRuns.at(-1)?.reasonCode).toBe(
            STEP_RUN_REASON.handlerFailed,
          )

          yield* lifecycle.retry(created.id)
          const afterRetry = yield* claimAndRunPending
          expect(afterRetry._tag).toBe("processed")
          if (afterRetry._tag === "processed") {
            expect(afterRetry.workItem.state).toBe("local_cleanup")
          }
          expect(closeAttempts).toBe(2)
        }),
      )
    })

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
            return {
              worktreePath: "/tmp/worktrees/concurrent",
              startingCommitOid: "abc123",
            }
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
      const queueShape = stubQueueService({
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
      })

      // Real DB + fake queue so we can fail the post-success enqueue.
      // Step run is started via runStep using the id from implementNow.
      const layer = WorkItemLifecycleLive.pipe(
        Layer.provideMerge(stubActiveAgentBackendLayer()),
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
          yield* seedHarnessBuildModel
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
        createWorktree: () =>
          Effect.fail(
            new LifecycleStepFailedError({ message: "worktree path busy" }),
          ),
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
            return {
              worktreePath: "/tmp/worktrees/too-slow",
              startingCommitOid: "abc123",
            }
          }),
      }

      const layer = makeWorkItemLifecycleLive({
        maxDurations: {
          create_worktree: Duration.millis(20),
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
      }).pipe(
        Layer.provideMerge(stubActiveAgentBackendLayer()),
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
            return Effect.fail(
              new LifecycleStepFailedError({ message: "first attempt failed" }),
            )
          }
          return Effect.succeed({
            worktreePath: "/tmp/worktrees/retry-success",
            startingCommitOid: "abc123",
          })
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
        createWorktree: () =>
          Effect.fail(
            new LifecycleStepFailedError({ message: "still failing" }),
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

    it("recovers a persisted terminal status-check failure into Watch", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const sql = yield* SqlClient.SqlClient
          const { repository, issue } = yield* seedActionableIssue
          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          const now = Date.now()

          yield* sql.unsafe(`DELETE FROM job_queue`)
          yield* sql.unsafe(
            `UPDATE step_run
             SET status = 'succeeded', started_at = ?, finished_at = ?, updated_at = ?
             WHERE id = ?`,
            [now, now, now, created.stepRuns[0]!.id],
          )
          yield* sql.unsafe(
            `UPDATE work_item
             SET state = 'failed',
                 failure_code = 'pr_status_checks_unresolved',
                 failure_message = 'Legacy unresolved checks',
                 holds_worker_slot = 0,
                 updated_at = ?
             WHERE id = ?`,
            [now, created.id],
          )

          const retried = yield* lifecycle.retry(created.id)
          expect(retried.state).toBe("watch_pr_status_checks")
          expect(retried.failureCode).toBeNull()
          expect(retried.failureMessage).toBeNull()
          expect(retried.stepRuns.at(-1)).toMatchObject({
            step: "watch_pr_status_checks",
            status: "queued",
          })
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
          Effect.fail(
            new LifecycleStepFailedError({
              message: "fail for concurrent retry",
            }),
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
    it("marks a Running Step Run Interrupted when its queue job is missing", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const sql = yield* SqlClient.SqlClient
          const { repository, issue } = yield* seedActionableIssue
          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          const stepRun = created.stepRuns[0]!
          const now = Date.now()

          yield* sql.unsafe(
            `UPDATE step_run
             SET status = 'running', started_at = ?, updated_at = ?
             WHERE id = ?`,
            [now, now, stepRun.id],
          )
          yield* sql.unsafe("DELETE FROM job_queue WHERE id = ?", [
            stepRun.queueJobId,
          ])

          yield* sql.unsafe(
            `UPDATE work_item
             SET holds_worker_slot = 1, updated_at = ?
             WHERE id = ?`,
            [now, created.id],
          )

          expect(yield* lifecycle.recoverOrphanedStepRuns).toBe(1)

          const recovered = yield* lifecycle.getWorkItem(created.id)
          expect(recovered.stepRuns[0]?.status).toBe("interrupted")
          expect(recovered.stepRuns[0]?.reasonCode).toBe(
            STEP_RUN_REASON.interrupted,
          )
          expect(recovered.stepRuns[0]?.reasonMessage).toBe(
            "Lifecycle Step lost its queue delivery",
          )
          expect(recovered.holdsWorkerSlot).toBe(false)
        }),
      ))

    it("marks a Running Step Run Interrupted when its final queue lease expires", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const sql = yield* SqlClient.SqlClient
          const { repository, issue } = yield* seedActionableIssue
          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          const stepRun = created.stepRuns[0]!
          const now = Date.now()

          yield* sql.unsafe(
            `UPDATE step_run
             SET status = 'running', started_at = ?, updated_at = ?
             WHERE id = ?`,
            [now, now, stepRun.id],
          )
          yield* sql.unsafe(
            `UPDATE job_queue
             SET job_attempts = job_retry_limit,
                 locked_until = ?,
                 updated_at = ?
             WHERE id = ?`,
            [now + 60_000, now, stepRun.queueJobId],
          )

          expect(yield* lifecycle.recoverOrphanedStepRuns).toBe(0)

          yield* sql.unsafe(
            `UPDATE job_queue SET locked_until = ?, updated_at = ? WHERE id = ?`,
            [now - 1, now, stepRun.queueJobId],
          )

          expect(yield* lifecycle.recoverOrphanedStepRuns).toBe(1)

          const recovered = yield* lifecycle.getWorkItem(created.id)
          expect(recovered.stepRuns[0]?.status).toBe("interrupted")
          expect(recovered.stepRuns[0]?.reasonCode).toBe(
            STEP_RUN_REASON.interrupted,
          )
          expect(recovered.holdsWorkerSlot).toBe(false)
          const remainingJobs = (yield* sql.unsafe(
            `SELECT id FROM job_queue WHERE id = ?`,
            [stepRun.queueJobId],
          )) as readonly { readonly id: string }[]
          expect(remainingJobs).toHaveLength(0)
        }),
      ))

    it("interrupts a Running Step Run with a still-valid queue lock on prior-worker reconciliation", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const sql = yield* SqlClient.SqlClient
          const queue = yield* QueueService
          const { repository, issue } = yield* seedActionableIssue
          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          const stepRun = created.stepRuns[0]!
          const now = Date.now()
          const lockUntil = now + Duration.toMillis(Duration.hours(2))

          yield* sql.unsafe(
            `UPDATE step_run
             SET status = 'running', started_at = ?, updated_at = ?
             WHERE id = ?`,
            [now, now, stepRun.id],
          )
          yield* sql.unsafe(
            `UPDATE job_queue
             SET locked_until = ?,
                 job_attempts = 0,
                 updated_at = ?
             WHERE id = ?`,
            [lockUntil, now, stepRun.queueJobId],
          )
          yield* sql.unsafe(
            `UPDATE work_item
             SET holds_worker_slot = 1, updated_at = ?
             WHERE id = ?`,
            [now, created.id],
          )

          // Lease-only orphan recovery must not touch a healthy-looking lock.
          expect(yield* lifecycle.recoverOrphanedStepRuns).toBe(0)

          expect(yield* lifecycle.interruptRunningStepRunsFromPriorWorker).toBe(
            1,
          )

          const recovered = yield* lifecycle.getWorkItem(created.id)
          expect(recovered.stepRuns[0]?.status).toBe("interrupted")
          expect(recovered.stepRuns[0]?.reasonCode).toBe(
            STEP_RUN_REASON.workerRestarted,
          )
          expect(recovered.stepRuns[0]?.reasonMessage).toContain(
            "stopped or restarted",
          )
          expect(recovered.holdsWorkerSlot).toBe(false)

          const remainingJobs = (yield* sql.unsafe(
            `SELECT id FROM job_queue WHERE id = ?`,
            [stepRun.queueJobId],
          )) as readonly { readonly id: string }[]
          expect(remainingJobs).toHaveLength(0)

          // No silent redelivery / auto-rerun of the interrupted step.
          const claimed = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
          expect(Option.isNone(claimed)).toBe(true)

          // Operator Retry still works.
          const retried = yield* lifecycle.retry(created.id)
          expect(retried.stepRuns).toHaveLength(2)
          expect(retried.stepRuns[0]!.status).toBe("interrupted")
          expect(retried.stepRuns[1]!.status).toBe("queued")
        }),
      ))

    it("does not interrupt live Running Step Runs during periodic orphan recovery", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const sql = yield* SqlClient.SqlClient
          const { repository, issue } = yield* seedActionableIssue
          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          const stepRun = created.stepRuns[0]!
          const now = Date.now()

          yield* sql.unsafe(
            `UPDATE step_run
             SET status = 'running', started_at = ?, updated_at = ?
             WHERE id = ?`,
            [now, now, stepRun.id],
          )
          yield* sql.unsafe(
            `UPDATE job_queue
             SET locked_until = ?, job_attempts = 0, updated_at = ?
             WHERE id = ?`,
            [now + 60_000, now, stepRun.queueJobId],
          )

          expect(yield* lifecycle.recoverOrphanedStepRuns).toBe(0)

          const stillRunning = yield* lifecycle.getWorkItem(created.id)
          expect(stillRunning.stepRuns[0]?.status).toBe("running")
        }),
      ))

    it("acknowledges a stale delivery without invoking a handler", () => {
      let createCalls = 0
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        createWorktree: () => {
          createCalls += 1
          return Effect.succeed({
            worktreePath: "/tmp/worktrees/stale-delivery",
            startingCommitOid: "abc123",
          })
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
          return Effect.succeed({
            worktreePath: "/tmp/worktrees/should-not-rerun",
            startingCommitOid: "abc123",
          })
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

    it("interrupts a stale OpenCode session-slot wait on lease redelivery", () => {
      let createCalls = 0
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        createWorktree: () => {
          createCalls += 1
          return Effect.succeed({
            worktreePath: "/tmp/worktrees/should-not-rerun-wait",
            startingCommitOid: "abc123",
          })
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
          const maxMs = Duration.toMillis(
            lifecycle.maxDurations.create_worktree,
          )
          const startedAt = now - maxMs - 5_000

          yield* sql.unsafe(
            `UPDATE step_run
             SET status = 'running',
                 started_at = ?,
                 session_wait_started_at = ?,
                 session_wait_ms = 0,
                 reason_code = ?,
                 reason_message = ?,
                 updated_at = ?
             WHERE id = ?`,
            [
              startedAt,
              startedAt + 100,
              STEP_RUN_REASON.waitingForAgentTurn,
              "Waiting for an OpenCode session slot",
              now,
              stepRunId,
            ],
          )
          yield* sql.unsafe(
            `UPDATE job_queue
             SET locked_until = ?, updated_at = ?
             WHERE id = ?`,
            [now - 1, now, jobId],
          )

          const claimed = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
          expect(Option.isSome(claimed)).toBe(true)

          const result = yield* lifecycle.runStep(stepRunId)
          expect(result._tag).toBe("noop")
          expect(createCalls).toBe(0)

          const final = yield* lifecycle.getWorkItem(created.id)
          expect(final.stepRuns[0]!.status).toBe("interrupted")
          expect(final.stepRuns[0]!.reasonCode).toBe(
            STEP_RUN_REASON.interrupted,
          )
        }),
      )
    })

    it("does not timeout solely for OpenCode session-slot wait longer than maxDuration", () => {
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        createWorktree: () =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            const rows = (yield* sql.unsafe(
              `SELECT id FROM step_run WHERE status = 'running' LIMIT 1`,
            )) as readonly { readonly id: string }[]
            const stepRunId = rows[0]!.id
            const waitStart = Date.now()
            yield* sql.unsafe(
              `UPDATE step_run
               SET session_wait_started_at = ?,
                   reason_code = ?,
                   reason_message = ?,
                   updated_at = ?
               WHERE id = ?`,
              [
                waitStart,
                STEP_RUN_REASON.waitingForAgentTurn,
                "Waiting for an OpenCode session slot",
                waitStart,
                stepRunId,
              ],
            )
            // Wall time well past maxDuration (20ms) while wait freezes the clock.
            yield* Effect.sleep("80 millis")
            const waitEnd = Date.now()
            yield* sql.unsafe(
              `UPDATE step_run
               SET session_wait_ms = session_wait_ms + ?,
                   session_wait_started_at = NULL,
                   reason_code = NULL,
                   reason_message = NULL,
                   updated_at = ?
               WHERE id = ?`,
              [waitEnd - waitStart, waitEnd, stepRunId],
            )
            return {
              worktreePath: "/tmp/worktrees/after-session-wait",
              startingCommitOid: "abc123",
            }
          }),
      }

      const layer = makeWorkItemLifecycleLive({
        maxDurations: {
          create_worktree: Duration.millis(20),
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
      }).pipe(
        Layer.provideMerge(stubActiveAgentBackendLayer()),
        Layer.provideMerge(
          Layer.succeed(LifecycleSteps, LifecycleSteps.of(steps)),
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

          yield* lifecycle.implementNow(repository.id, issue.githubIssueNumber)
          const claimed = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
          expect(Option.isSome(claimed)).toBe(true)
          if (Option.isNone(claimed)) {
            return yield* Effect.die("expected lifecycle job")
          }

          const result = yield* lifecycle.runStep(
            (claimed.value.payload as { stepRunId: string }).stepRunId,
          )
          expect(result._tag).toBe("processed")
          if (result._tag === "processed") {
            expect(result.workItem.state).toBe("install_dependencies")
            expect(result.workItem.stepRuns[0]!.status).toBe("succeeded")
          }
        }).pipe(Effect.provide(layer)),
      )
    })

    it("still times out when productive work exceeds maxDuration after a session wait", () => {
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        createWorktree: () =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            const rows = (yield* sql.unsafe(
              `SELECT id FROM step_run WHERE status = 'running' LIMIT 1`,
            )) as readonly { readonly id: string }[]
            const stepRunId = rows[0]!.id
            const waitStart = Date.now()
            yield* sql.unsafe(
              `UPDATE step_run
               SET session_wait_started_at = ?,
                   reason_code = ?,
                   updated_at = ?
               WHERE id = ?`,
              [
                waitStart,
                STEP_RUN_REASON.waitingForAgentTurn,
                waitStart,
                stepRunId,
              ],
            )
            yield* Effect.sleep("40 millis")
            const waitEnd = Date.now()
            yield* sql.unsafe(
              `UPDATE step_run
               SET session_wait_ms = session_wait_ms + ?,
                   session_wait_started_at = NULL,
                   reason_code = NULL,
                   updated_at = ?
               WHERE id = ?`,
              [waitEnd - waitStart, waitEnd, stepRunId],
            )
            // Productive overrun after the wait.
            yield* Effect.sleep("80 millis")
            return {
              worktreePath: "/tmp/worktrees/productive-overrun",
              startingCommitOid: "abc123",
            }
          }),
      }

      const layer = makeWorkItemLifecycleLive({
        maxDurations: {
          create_worktree: Duration.millis(30),
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
      }).pipe(
        Layer.provideMerge(stubActiveAgentBackendLayer()),
        Layer.provideMerge(
          Layer.succeed(LifecycleSteps, LifecycleSteps.of(steps)),
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

          yield* lifecycle.implementNow(repository.id, issue.githubIssueNumber)
          const claimed = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
          expect(Option.isSome(claimed)).toBe(true)
          if (Option.isNone(claimed)) {
            return yield* Effect.die("expected lifecycle job")
          }

          const result = yield* lifecycle.runStep(
            (claimed.value.payload as { stepRunId: string }).stepRunId,
          )
          expect(result._tag).toBe("processed")
          if (result._tag === "processed") {
            const run = result.workItem.stepRuns[0]!
            expect(run.status).toBe("failed")
            expect(run.reasonCode).toBe(STEP_RUN_REASON.timeout)
          }
        }).pipe(Effect.provide(layer)),
      )
    })

    it("records Interrupted when the handler is fiber-interrupted before an outcome is established", () => {
      const hangForever: LifecycleStepsShape = {
        ...successfulSteps,
        createWorktree: () =>
          Effect.gen(function* () {
            yield* Effect.sleep("10 seconds")
            return {
              worktreePath: "/tmp/worktrees/never",
              startingCommitOid: "abc123",
            }
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
        createWorktree: () =>
          Effect.fail(
            new LifecycleStepFailedError({ message: "fail then abandon" }),
          ),
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
            Effect.as({
              worktreePath: "/tmp/worktrees/concurrent-abandon",
              startingCommitOid: "abc123",
            }),
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

  describe("Repository removal", () => {
    it("rejects removal while a Step Run is Running and leaves data unchanged", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const db = yield* DbService
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

          const error = yield* Effect.flip(db.removeRepository(repository.id))
          expect(error).toBeInstanceOf(RepositoryHasRunningStepError)
          if (error instanceof RepositoryHasRunningStepError) {
            expect(error.repositoryId).toBe(repository.id)
            expect(error.stepRunId).toBe(created.stepRuns[0]!.id)
            expect(error.workItemId).toBe(created.id)
          }

          expect(yield* db.listRepositories).toHaveLength(1)
          expect(
            yield* lifecycle.listWorkItemsForIssue(
              repository.id,
              issue.githubIssueNumber,
            ),
          ).toHaveLength(1)
          const jobs = yield* sql.unsafe(
            "SELECT id FROM job_queue WHERE id = ?",
            [created.stepRuns[0]!.queueJobId],
          )
          expect(jobs).toHaveLength(1)
          expect(
            (yield* lifecycle.getWorkItem(created.id)).stepRuns[0]!.status,
          ).toBe("running")
        }),
      ))

    it("removes queued and Failed history with the Repository when nothing is Running", () => {
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        createWorktree: () =>
          Effect.fail(
            new LifecycleStepFailedError({ message: "failed before removal" }),
          ),
      }

      return runWithSteps(
        steps,
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const db = yield* DbService
          const sql = yield* SqlClient.SqlClient
          const queue = yield* QueueService
          const { repository, issue } = yield* seedActionableIssue

          const failed = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          const failedJob = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
          if (Option.isNone(failedJob)) {
            return yield* Effect.die("expected job")
          }
          yield* lifecycle.runStep(
            (failedJob.value.payload as { stepRunId: string }).stepRunId,
          )
          const afterFailure = yield* lifecycle.getWorkItem(failed.id)
          expect(afterFailure.stepRuns[0]!.status).toBe("failed")

          yield* lifecycle.abandon(failed.id)

          const stillQueued = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          expect(stillQueued.state).toBe("create_worktree")
          expect(
            (yield* lifecycle.listWorkItemsForIssue(
              repository.id,
              issue.githubIssueNumber,
            )).map((item) => item.state),
          ).toEqual(["abandoned", "create_worktree"])

          yield* db.removeRepository(repository.id)

          expect(yield* db.listRepositories).toEqual([])
          expect(yield* sql.unsafe("SELECT id FROM work_item")).toEqual([])
          expect(yield* sql.unsafe("SELECT id FROM step_run")).toEqual([])
          expect(yield* sql.unsafe("SELECT id FROM issue")).toEqual([])
          expect(
            yield* sql.unsafe("SELECT id FROM job_queue WHERE id IN (?, ?)", [
              failed.stepRuns[0]!.queueJobId,
              stillQueued.stepRuns[0]!.queueJobId,
            ]),
          ).toEqual([])
        }),
      )
    })

    it("rolls back all lifecycle and Repository changes when removal fails", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const db = yield* DbService
          const queue = yield* QueueService
          const sql = yield* SqlClient.SqlClient
          const { repository, issue } = yield* seedActionableIssue

          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          yield* sql.unsafe(
            `CREATE TRIGGER reject_repository_removal
             BEFORE DELETE ON repository
             BEGIN
               SELECT RAISE(ABORT, 'injected removal failure');
             END`,
          )

          const error = yield* Effect.flip(db.removeRepository(repository.id))
          expect(error._tag).toBe("DatabaseError")

          expect(yield* db.listRepositories).toHaveLength(1)
          expect(yield* db.listIssues(repository.id)).toHaveLength(1)
          const unchanged = yield* lifecycle.getWorkItem(created.id)
          expect(unchanged.state).toBe("create_worktree")
          expect(unchanged.stepRuns[0]!.status).toBe("queued")

          const queued = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
          expect(Option.isSome(queued)).toBe(true)
          if (Option.isSome(queued)) {
            expect(queued.value.jobId).toBe(created.stepRuns[0]!.queueJobId)
          }
        }),
      ))
  })

  describe("reset", () => {
    it("deletes a Queued Work Item, acks its job, and allows Implement Now again", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const queue = yield* QueueService
          const { repository, issue } = yield* seedActionableIssue

          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )

          const deletedId = yield* lifecycle.reset(created.id)
          expect(deletedId).toBe(created.id)

          const missing = yield* Effect.flip(lifecycle.getWorkItem(created.id))
          expect(missing).toBeInstanceOf(WorkItemNotFoundError)

          const remaining = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
          expect(Option.isNone(remaining)).toBe(true)

          const listed = yield* lifecycle.listWorkItemsForIssue(
            repository.id,
            issue.githubIssueNumber,
          )
          expect(listed).toHaveLength(0)

          const next = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          expect(next.id).not.toBe(created.id)
          expect(next.state).toBe("create_worktree")
        }),
      ))

    it("interrupts a Running Step Run, deletes history, and proceeds", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const queue = yield* QueueService
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

          const deletedId = yield* lifecycle.reset(created.id)
          expect(deletedId).toBe(created.id)

          const missing = yield* Effect.flip(lifecycle.getWorkItem(created.id))
          expect(missing).toBeInstanceOf(WorkItemNotFoundError)

          const remaining = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
          expect(Option.isNone(remaining)).toBe(true)

          const next = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          expect(next.id).not.toBe(created.id)
        }),
      ))

    it("interrupts and awaits the active handler before cleanup", async () => {
      const started = await Effect.runPromise(Deferred.make<void>())
      const interrupted = await Effect.runPromise(Deferred.make<void>())
      const cleanupStarted = await Effect.runPromise(Deferred.make<void>())
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        createWorktree: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(interrupted, undefined)),
          ),
        removeWorktree: () =>
          Deferred.await(interrupted).pipe(
            Effect.andThen(Deferred.succeed(cleanupStarted, undefined)),
            Effect.asVoid,
          ),
      }

      await runWithSteps(
        steps,
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const queue = yield* QueueService
          const { repository, issue } = yield* seedActionableIssue
          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          const job = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
          if (Option.isNone(job)) {
            return yield* Effect.die("expected job")
          }

          const runFiber = yield* lifecycle
            .runStep((job.value.payload as { stepRunId: string }).stepRunId)
            .pipe(Effect.forkChild)
          yield* Deferred.await(started)

          expect(yield* lifecycle.reset(created.id)).toBe(created.id)
          expect(yield* Deferred.isDone(interrupted)).toBe(true)
          expect(yield* Deferred.isDone(cleanupStarted)).toBe(true)
          yield* Fiber.join(runFiber)

          const missing = yield* Effect.flip(lifecycle.getWorkItem(created.id))
          expect(missing).toBeInstanceOf(WorkItemNotFoundError)
        }),
      )
    })

    it("preserves the Work Item when worktree cleanup fails", () => {
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        removeWorktree: () =>
          Effect.fail(
            new LifecycleStepFailedError({ message: "worktree is locked" }),
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

          const error = yield* Effect.flip(lifecycle.reset(created.id))
          expect(error).toBeInstanceOf(ResetCleanupError)

          const preserved = yield* lifecycle.getWorkItem(created.id)
          expect(preserved.id).toBe(created.id)
          expect(preserved.stepRuns[0]!.status).toBe("queued")
        }),
      )
    })

    it("deletes terminal Work Items including Complete and Abandoned", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const { repository, issue } = yield* seedActionableIssue

          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          yield* lifecycle.abandon(created.id)

          const deletedId = yield* lifecycle.reset(created.id)
          expect(deletedId).toBe(created.id)

          const listed = yield* lifecycle.listWorkItemsForIssue(
            repository.id,
            issue.githubIssueNumber,
          )
          expect(listed).toHaveLength(0)
        }),
      ))

    it("calls removeWorktree with Work Item context before finishing", () => {
      const seen: LifecycleStepContext[] = []
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        createWorktree: () =>
          Effect.succeed({
            worktreePath: "/tmp/worktrees/reset-me",
            startingCommitOid: "abc123",
          }),
        removeWorktree: (context) => {
          seen.push(context)
          return Effect.void
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
          const job = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
          expect(Option.isSome(job)).toBe(true)
          if (Option.isNone(job)) {
            return yield* Effect.die("expected job")
          }
          yield* lifecycle.runStep(
            (job.value.payload as { stepRunId: string }).stepRunId,
          )

          const afterCreate = yield* lifecycle.getWorkItem(created.id)
          expect(afterCreate.worktreePath).toBe("/tmp/worktrees/reset-me")

          yield* lifecycle.reset(created.id)

          expect(seen).toHaveLength(1)
          expect(seen[0]).toEqual({
            workItemId: created.id,
            repositoryId: repository.id,
            githubIssueNumber: issue.githubIssueNumber,
            model: "",
            thinkingLevel: null,
            reviewModel: "",
            reviewThinkingLevel: null,
            worktreePath: "/tmp/worktrees/reset-me",
            startingCommitOid: "abc123",
            completionSummary: null,
            sessionId: null,
          })
        }),
      )
    })

    it("rejects reset for an unknown Work Item", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const error = yield* Effect.flip(
            lifecycle.reset("wi-01AAAAAAAAAAAAAAAAAAAAAAAA"),
          )
          expect(error).toBeInstanceOf(WorkItemNotFoundError)
        }),
      ))
  })

  describe("pause and start", () => {
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

    it("marks a Work Item paused and cancels queued Step Runs", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const queue = yield* QueueService
          const { repository, issue } = yield* seedActionableIssue

          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          expect(created.paused).toBe(false)
          expect(created.stepRuns[0]!.status).toBe("queued")

          const paused = yield* lifecycle.pause(created.id)
          expect(paused.paused).toBe(true)
          expect(paused.stepRuns).toHaveLength(1)
          expect(paused.stepRuns[0]!.status).toBe("cancelled")
          expect(paused.stepRuns[0]!.reasonCode).toBe(STEP_RUN_REASON.paused)

          const remaining = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
          expect(Option.isNone(remaining)).toBe(true)

          const again = yield* lifecycle.pause(created.id)
          expect(again.paused).toBe(true)
        }),
      ))

    it("starts a paused Work Item and enqueues the current Lifecycle Step", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const { repository, issue } = yield* seedActionableIssue

          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          yield* lifecycle.pause(created.id)

          const started = yield* lifecycle.start(created.id)
          expect(started.paused).toBe(false)
          expect(started.state).toBe("create_worktree")
          expect(started.stepRuns.map((run) => run.status)).toEqual([
            "cancelled",
            "queued",
          ])
          expect(started.stepRuns[1]!.step).toBe("create_worktree")

          const idle = yield* lifecycle.start(created.id)
          expect(idle.paused).toBe(false)
          expect(idle.stepRuns).toHaveLength(2)
        }),
      ))

    it("advances state while paused without enqueueing the next Step Run", async () => {
      const started = await Effect.runPromise(Deferred.make<void>())
      const release = await Effect.runPromise(Deferred.make<void>())
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        createWorktree: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as({
              worktreePath: "/tmp/worktrees/paused-drain",
              startingCommitOid: "abc123",
            }),
          ),
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

          const fiber = yield* Effect.forkChild(lifecycle.runStep(stepRunId))
          yield* Deferred.await(started)

          const paused = yield* lifecycle.pause(created.id)
          expect(paused.paused).toBe(true)
          expect(
            paused.stepRuns.find((run) => run.id === stepRunId)?.status,
          ).toBe("running")

          yield* Deferred.succeed(release, undefined)
          const result = yield* Fiber.join(fiber)
          expect(result._tag).toBe("processed")
          if (result._tag === "processed") {
            expect(result.workItem.paused).toBe(true)
            expect(result.workItem.state).toBe("install_dependencies")
            expect(
              result.workItem.stepRuns.map((run) => [run.step, run.status]),
            ).toEqual([["create_worktree", "succeeded"]])
          }

          const remaining = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
          expect(Option.isNone(remaining)).toBe(true)

          const afterStart = yield* lifecycle.start(created.id)
          expect(afterStart.paused).toBe(false)
          expect(afterStart.state).toBe("install_dependencies")
          expect(afterStart.stepRuns.at(-1)).toMatchObject({
            step: "install_dependencies",
            status: "queued",
          })
        }),
      )
    })

    it("rejects Retry while paused and allows it after Start", () => {
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        createWorktree: () =>
          Effect.fail(
            new LifecycleStepFailedError({ message: "fail for retry" }),
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
          yield* claimAndRunPending
          yield* lifecycle.pause(created.id)

          const blocked = yield* Effect.flip(lifecycle.retry(created.id))
          expect(blocked).toBeInstanceOf(RetryNotEligibleError)
          if (blocked instanceof RetryNotEligibleError) {
            expect(blocked.reason).toBe("paused")
          }

          const started = yield* lifecycle.start(created.id)
          expect(started.paused).toBe(false)
          // failed latest still needs explicit Retry after Start
          expect(started.stepRuns.every((run) => run.status !== "queued")).toBe(
            true,
          )

          const retried = yield* lifecycle.retry(created.id)
          expect(retried.stepRuns.at(-1)?.status).toBe("queued")
        }),
      )
    })

    it("rejects pause and start for terminal Work Items", () =>
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
            `UPDATE work_item SET state = 'complete', updated_at = ? WHERE id = ?`,
            [Date.now(), created.id],
          )

          const pauseError = yield* Effect.flip(lifecycle.pause(created.id))
          expect(pauseError).toBeInstanceOf(WorkItemTerminalError)

          const startError = yield* Effect.flip(lifecycle.start(created.id))
          expect(startError).toBeInstanceOf(WorkItemTerminalError)
        }),
      ))
  })

  describe("Work Item change invalidation", () => {
    it("publishes after successful Work Item persistence", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const db = yield* DbService
          const { repository, issue } = yield* seedActionableIssue

          const changes = yield* db.workItemChanges.pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.forkChild,
          )
          yield* Effect.yieldNow

          yield* lifecycle.implementNow(repository.id, issue.githubIssueNumber)

          expect(yield* Fiber.join(changes)).toEqual([repository.id])
        }),
      ))

    it("does not publish when create fails before persistence", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const db = yield* DbService
          const { repository } = yield* seedActionableIssue

          const changes = db.workItemChanges.pipe(
            Stream.take(1),
            Stream.runCollect,
          )

          const error = yield* Effect.flip(
            lifecycle.implementNow(repository.id, 999_999),
          )
          expect(error).toBeInstanceOf(IssueNotFoundError)

          const raced = yield* Effect.race(
            changes.pipe(Effect.as("published" as const)),
            Effect.sleep(Duration.millis(50)).pipe(
              Effect.as("silent" as const),
            ),
          )
          expect(raced).toBe("silent")

          const workItems = yield* lifecycle.listWorkItemsForRepository(
            repository.id,
          )
          expect(workItems).toEqual([])
        }),
      ))

    it("publishes after a successful step transition", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const db = yield* DbService
          const { repository, issue } = yield* seedActionableIssue

          const workItem = yield* lifecycle.implementNow(
            repository.id,
            issue.githubIssueNumber,
          )
          const stepRunId = workItem.stepRuns[0]!.id

          const changes = yield* db.workItemChanges.pipe(
            Stream.take(2),
            Stream.runCollect,
            Effect.forkChild,
          )
          yield* Effect.yieldNow

          yield* lifecycle.runStep(stepRunId)

          const published = yield* Fiber.join(changes)
          expect(published).toContain(repository.id)
          expect(published.length).toBeGreaterThanOrEqual(1)
        }),
      ))
  })

  describe("Worker Slots", () => {
    const seedIssue = (githubIssueNumber: number) =>
      Effect.gen(function* () {
        const db = yield* DbService
        yield* seedHarnessBuildModel
        const repository = yield* db.addRepository({
          ...sampleRepository,
          localPath: `/repos/acme/widgets-${githubIssueNumber}.git`,
          githubRepo: `widgets-${githubIssueNumber}`,
        })
        const issue = yield* db.storeIssue({
          repositoryId: repository.id,
          githubIssueNumber,
          ...sampleIssueFields,
          url: `https://github.com/acme/widgets/issues/${githubIssueNumber}`,
        })
        return { repository, issue }
      })

    const setMaxWorkItems = (maxConcurrentWorkItems: number) =>
      Effect.gen(function* () {
        const db = yield* DbService
        const config = yield* db.getConfig
        yield* db.updateConfig({
          selectedAgentBackend: "opencode",
          defaultModel:
            config.defaultModel ?? "opencode/deepseek-v4-flash-free",
          defaultThinkingLevel: config.defaultThinkingLevel ?? "low",
          reviewModel: config.reviewModel,
          reviewThinkingLevel: config.reviewThinkingLevel,
          maxConcurrentAgentTurns: config.maxConcurrentAgentTurns,
          maxConcurrentWorkItems,
        })
      })

    it("admits up to the limit and queues extras as Waiting for Worker Slot", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          yield* setMaxWorkItems(2)

          const a = yield* seedIssue(101)
          const b = yield* seedIssue(102)
          const c = yield* seedIssue(103)

          const first = yield* lifecycle.implementNow(
            a.repository.id,
            a.issue.githubIssueNumber,
          )
          const second = yield* lifecycle.implementNow(
            b.repository.id,
            b.issue.githubIssueNumber,
          )
          const third = yield* lifecycle.implementNow(
            c.repository.id,
            c.issue.githubIssueNumber,
          )

          expect(first.holdsWorkerSlot).toBe(true)
          expect(first.waitingSince).toBeNull()
          expect(first.stepRuns).toHaveLength(1)

          expect(second.holdsWorkerSlot).toBe(true)
          expect(second.waitingSince).toBeNull()
          expect(second.stepRuns).toHaveLength(1)

          expect(third.holdsWorkerSlot).toBe(false)
          expect(third.waitingSince).not.toBeNull()
          expect(third.stepRuns).toHaveLength(0)
          expect(third.state).toBe("create_worktree")
        }),
      ))

    it("admits waiters FIFO when a slot is released by abandon", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          yield* setMaxWorkItems(1)

          const a = yield* seedIssue(201)
          const b = yield* seedIssue(202)
          const c = yield* seedIssue(203)

          const first = yield* lifecycle.implementNow(
            a.repository.id,
            a.issue.githubIssueNumber,
          )
          const second = yield* lifecycle.implementNow(
            b.repository.id,
            b.issue.githubIssueNumber,
          )
          const third = yield* lifecycle.implementNow(
            c.repository.id,
            c.issue.githubIssueNumber,
          )

          expect(first.holdsWorkerSlot).toBe(true)
          expect(second.waitingSince).not.toBeNull()
          expect(third.waitingSince).not.toBeNull()

          yield* lifecycle.abandon(first.id)

          const admittedSecond = yield* lifecycle.getWorkItem(second.id)
          const stillWaitingThird = yield* lifecycle.getWorkItem(third.id)

          expect(admittedSecond.holdsWorkerSlot).toBe(true)
          expect(admittedSecond.waitingSince).toBeNull()
          expect(admittedSecond.stepRuns).toHaveLength(1)
          expect(stillWaitingThird.holdsWorkerSlot).toBe(false)
          expect(stillWaitingThird.waitingSince).not.toBeNull()
          expect(stillWaitingThird.stepRuns).toHaveLength(0)
        }),
      ))

    it("releases a slot on Pause when idle and re-acquires on Start", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          yield* setMaxWorkItems(1)

          const a = yield* seedIssue(301)
          const b = yield* seedIssue(302)

          const first = yield* lifecycle.implementNow(
            a.repository.id,
            a.issue.githubIssueNumber,
          )
          const waiter = yield* lifecycle.implementNow(
            b.repository.id,
            b.issue.githubIssueNumber,
          )
          expect(waiter.waitingSince).not.toBeNull()

          const paused = yield* lifecycle.pause(first.id)
          expect(paused.paused).toBe(true)
          expect(paused.holdsWorkerSlot).toBe(false)

          const admittedWaiter = yield* lifecycle.getWorkItem(waiter.id)
          expect(admittedWaiter.holdsWorkerSlot).toBe(true)
          expect(admittedWaiter.waitingSince).toBeNull()
          expect(admittedWaiter.stepRuns).toHaveLength(1)

          const started = yield* lifecycle.start(first.id)
          expect(started.paused).toBe(false)
          expect(started.holdsWorkerSlot).toBe(false)
          expect(started.waitingSince).not.toBeNull()
        }),
      ))

    it("releases a slot on non-terminal failure; Retry re-acquires or waits", () =>
      runWithSteps(
        {
          ...successfulSteps,
          createWorktree: () =>
            Effect.fail(new LifecycleStepFailedError({ message: "boom" })),
        },
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const queue = yield* QueueService
          yield* setMaxWorkItems(1)

          const a = yield* seedIssue(401)
          const b = yield* seedIssue(402)

          const first = yield* lifecycle.implementNow(
            a.repository.id,
            a.issue.githubIssueNumber,
          )
          const waiter = yield* lifecycle.implementNow(
            b.repository.id,
            b.issue.githubIssueNumber,
          )

          const claimed = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
          expect(Option.isSome(claimed)).toBe(true)
          if (Option.isSome(claimed)) {
            yield* lifecycle.runStep(
              (claimed.value.payload as { stepRunId: string }).stepRunId,
            )
          }

          const failed = yield* lifecycle.getWorkItem(first.id)
          expect(failed.holdsWorkerSlot).toBe(false)
          expect(failed.waitingSince).toBeNull()
          expect(failed.stepRuns[0]!.status).toBe("failed")

          const admittedWaiter = yield* lifecycle.getWorkItem(waiter.id)
          expect(admittedWaiter.holdsWorkerSlot).toBe(true)

          const retried = yield* lifecycle.retry(first.id)
          expect(retried.holdsWorkerSlot).toBe(false)
          expect(retried.waitingSince).not.toBeNull()
          expect(
            retried.stepRuns.filter((r) => r.status === "queued"),
          ).toHaveLength(0)
        }),
      ))

    it("admits waiters immediately when the config limit is raised", () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          yield* setMaxWorkItems(1)

          const a = yield* seedIssue(501)
          const b = yield* seedIssue(502)

          yield* lifecycle.implementNow(
            a.repository.id,
            a.issue.githubIssueNumber,
          )
          const waiter = yield* lifecycle.implementNow(
            b.repository.id,
            b.issue.githubIssueNumber,
          )
          expect(waiter.waitingSince).not.toBeNull()

          yield* setMaxWorkItems(2)
          const admitted = yield* lifecycle.admitWaitingWorkItems
          expect(admitted).toBe(1)

          const after = yield* lifecycle.getWorkItem(waiter.id)
          expect(after.holdsWorkerSlot).toBe(true)
          expect(after.waitingSince).toBeNull()
          expect(after.stepRuns).toHaveLength(1)
        }),
      ))
  })
})
