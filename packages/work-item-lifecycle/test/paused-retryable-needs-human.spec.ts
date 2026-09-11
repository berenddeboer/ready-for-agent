import { Deferred, Effect, Fiber, Layer, Option, Result } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import { QueueService } from "@ready-for-agent/queue-service"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
  ActiveStepRunExistsError,
  LifecycleSteps,
  type LifecycleStepsShape,
  REVIEW_FIX_LIMIT_REASON,
  RetryNotEligibleError,
  WORK_ITEM_LIFECYCLE_QUEUE,
  WorkItemLifecycle,
  WorkItemLifecycleLive,
  WorkItemTerminalError,
  stubActiveAgentBackendLayer,
  stubAzureDevOpsServiceLayer,
  stubGitHubServiceLayer,
  stubGitLabServiceLayer,
} from "../src/index.js"
import { describe, expect, it, setDefaultTimeout } from "bun:test"

setDefaultTimeout(30_000)

describe("explicit Retry of a paused idle retryable Needs Human handoff", () => {
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
    commit: () =>
      Effect.succeed({
        _tag: "committed" as const,
        completion: "native" as const,
        publicationTitle: "feat: test",
        publicationBody: "Why\n\nCloses #1",
      }),
    createPr: () =>
      Effect.succeed({
        pullRequestNumber: 101,
        completion: "native" as const,
        publicationTitle: "feat: test",
        publicationBody: "Why\n\nCloses #1",
      }),
    watchPrStatusChecks: () =>
      Effect.succeed({
        _tag: "succeeded" as const,
        createdAt: new Date(0),
        headSha: "settled-head",
        headPushedAt: new Date(0),
        isDraft: false,
      }),
    resolvePrMergeConflict: () => Effect.succeed({ _tag: "processed" }),
    investigatePrStatusChecks: () =>
      Effect.succeed({ _tag: "processed", handledCheckIds: [] }),
    markPrReadyForReview: () =>
      Effect.succeed({ completion: "native" as const }),
    decidePrMerge: () => Effect.succeed({ _tag: "clanker_merge" }),
    mergePr: () => Effect.succeed({ _tag: "merged" }),
    closeIssue: () => Effect.void,
    localCleanup: () => Effect.void,
    removeWorktree: () => Effect.void,
  }

  const makeLayer = (steps: LifecycleStepsShape = successfulSteps) =>
    WorkItemLifecycleLive.pipe(
      Layer.provideMerge(stubActiveAgentBackendLayer()),
      Layer.provideMerge(stubGitHubServiceLayer()),
      Layer.provideMerge(stubGitLabServiceLayer()),
      Layer.provideMerge(stubAzureDevOpsServiceLayer()),
      Layer.provideMerge(
        Layer.succeed(LifecycleSteps, LifecycleSteps.of(steps)),
      ),
      Layer.provideMerge(DbServiceLive),
      Layer.provideMerge(SqliteQueueServiceLive),
      Layer.provideMerge(DatabaseTest),
    )

  const runWithSteps = <A, E>(
    steps: LifecycleStepsShape,
    test: Effect.Effect<
      A,
      E,
      | WorkItemLifecycle
      | DbService
      | QueueService
      | SqlClient.SqlClient
      | LifecycleSteps
    >,
  ): Promise<A> => Effect.runPromise(Effect.provide(test, makeLayer(steps)))

  const makeQueuedJobsAvailable = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
  })

  const claimAndRunPending = Effect.gen(function* () {
    const lifecycle = yield* WorkItemLifecycle
    const queue = yield* QueueService
    yield* makeQueuedJobsAvailable
    const claimed = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
    expect(Option.isSome(claimed)).toBe(true)
    if (Option.isNone(claimed)) {
      return yield* Effect.die("expected a queued lifecycle job")
    }
    const payload = claimed.value.payload as { stepRunId: string }
    return yield* lifecycle.runStep(payload.stepRunId)
  })

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

  const seedIssue = (input: {
    readonly projectPath?: string
    readonly issueNumber?: number
  }) =>
    Effect.gen(function* () {
      const db = yield* DbService
      yield* seedHarnessBuildModel
      const projectPath = input.projectPath ?? "acme/widgets"
      const issueNumber = input.issueNumber ?? 42
      const repository = yield* db.addRepository({
        forge: "github",
        forgeHost: "github.com",
        projectPath,
        localPath: `/repos/${projectPath}.git`,
        isBare: true,
      })
      const issue = yield* db.storeIssue({
        repositoryId: repository.id,
        issueNumber,
        title: "Implement feature",
        body: "Issue body",
        url: `https://github.com/${projectPath}/issues/${String(issueNumber)}`,
        state: "OPEN",
        githubCreatedAt: new Date("2026-01-15T12:00:00.000Z"),
        issueAuthor: null,
        parent: null,
        parentPosition: null,
        hasChildren: false,
        blockedBy: [],
      })
      return { repository, issue }
    })

  const persistPaused = (workItemId: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe(
        `UPDATE work_item SET paused = 1, updated_at = ? WHERE id = ?`,
        [Date.now(), workItemId],
      )
    })

  const driveToReviewNeedsHuman = Effect.gen(function* () {
    const lifecycle = yield* WorkItemLifecycle
    const { repository, issue } = yield* seedIssue({})
    yield* lifecycle.implementNow(repository.id, issue.issueNumber)
    for (let index = 0; index < 5; index += 1) {
      yield* claimAndRunPending
    }
    const afterReview = yield* claimAndRunPending
    expect(afterReview._tag).toBe("processed")
    if (afterReview._tag !== "processed") {
      return yield* Effect.die("expected Review to finish")
    }
    expect(afterReview.workItem.state).toBe("needs_human")
    expect(afterReview.workItem.failureCode).toBe("needs_human")
    expect(afterReview.workItem.holdsWorkerSlot).toBe(false)
    return { repository, created: afterReview.workItem, lifecycle }
  })

  it("pauses a running Review, keeps the Needs Human explanation, and Retry resumes Review", async () => {
    const started = await Effect.runPromise(Deferred.make<void>())
    const release = await Effect.runPromise(Deferred.make<void>())
    const reason = REVIEW_FIX_LIMIT_REASON
    let reviewCalls = 0
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      review: () => {
        reviewCalls += 1
        if (reviewCalls === 1) {
          return Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as({ _tag: "needs_human" as const, reason }),
          )
        }
        return Effect.succeed({ _tag: "clean" as const })
      },
    }

    return runWithSteps(
      steps,
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const queue = yield* QueueService
        const { repository, issue } = yield* seedIssue({})
        const created = yield* lifecycle.implementNow(
          repository.id,
          issue.issueNumber,
        )
        for (let index = 0; index < 5; index += 1) {
          yield* claimAndRunPending
        }
        const beforeReview = yield* lifecycle.getWorkItem(created.id)
        expect(beforeReview.state).toBe("review")
        const reviewRun = beforeReview.stepRuns.at(-1)
        expect(reviewRun?.status).toBe("queued")
        const priorStepRunCount = beforeReview.stepRuns.length
        const sessionId = beforeReview.sessionId
        const worktreePath = beforeReview.worktreePath

        const fiber = yield* Effect.forkChild(lifecycle.runStep(reviewRun!.id))
        yield* Deferred.await(started)

        const paused = yield* lifecycle.pause(created.id)
        expect(paused.paused).toBe(true)
        expect(
          paused.stepRuns.find((run) => run.id === reviewRun!.id)?.status,
        ).toBe("running")

        const duringDrain = yield* Effect.flip(lifecycle.retry(created.id))
        expect(duringDrain).toBeInstanceOf(RetryNotEligibleError)
        expect((yield* lifecycle.getWorkItem(created.id)).paused).toBe(true)

        yield* Deferred.succeed(release, undefined)
        const drained = yield* Fiber.join(fiber)
        expect(drained._tag).toBe("processed")
        if (drained._tag !== "processed") {
          return
        }
        expect(drained.workItem.paused).toBe(true)
        expect(drained.workItem.state).toBe("needs_human")
        expect(drained.workItem.failureMessage).toBe(reason)
        expect(drained.workItem.holdsWorkerSlot).toBe(false)
        expect(
          drained.workItem.stepRuns.some(
            (run) => run.status === "queued" || run.status === "running",
          ),
        ).toBe(false)
        expect(
          Option.isNone(yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)),
        ).toBe(true)

        const startBlocked = yield* Effect.flip(lifecycle.start(created.id))
        expect(startBlocked).toBeInstanceOf(WorkItemTerminalError)

        const retried = yield* lifecycle.retry(created.id)
        expect(retried.paused).toBe(false)
        expect(retried.state).toBe("review")
        expect(retried.failureCode).toBeNull()
        expect(retried.failureMessage).toBeNull()
        expect(retried.sessionId).toBe(sessionId)
        expect(retried.worktreePath).toBe(worktreePath)
        expect(retried.stepRuns).toHaveLength(priorStepRunCount + 1)
        expect(retried.stepRuns.at(-1)).toMatchObject({
          step: "review",
          status: "queued",
        })

        const secondReview = yield* claimAndRunPending
        expect(reviewCalls).toBe(2)
        expect(secondReview._tag).toBe("processed")
        if (secondReview._tag === "processed") {
          expect(secondReview.workItem.state).toBe("commit")
        }
      }),
    )
  })

  it("recovers an already-persisted paused Review Needs Human record through Retry", () => {
    const reason = REVIEW_FIX_LIMIT_REASON
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      review: () => Effect.succeed({ _tag: "needs_human" as const, reason }),
    }

    return runWithSteps(
      steps,
      Effect.gen(function* () {
        const { created, lifecycle } = yield* driveToReviewNeedsHuman
        expect(created.paused).toBe(false)
        yield* persistPaused(created.id)

        const stuck = yield* lifecycle.getWorkItem(created.id)
        expect(stuck.paused).toBe(true)
        expect(stuck.state).toBe("needs_human")
        expect(stuck.failureMessage).toBe(reason)
        expect(stuck.sessionId).toBe("ses_test_implement_session")

        const retried = yield* lifecycle.retry(created.id)
        expect(retried.paused).toBe(false)
        expect(retried.state).toBe("review")
        expect(retried.sessionId).toBe(stuck.sessionId)
        expect(retried.worktreePath).toBe(stuck.worktreePath)
        expect(retried.stepRuns.at(-1)).toMatchObject({
          step: "review",
          status: "queued",
        })
      }),
    )
  })

  it("enters Waiting for Worker Slot on Retry and later creates exactly one Review Step Run", () => {
    const reason = REVIEW_FIX_LIMIT_REASON
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      review: () => Effect.succeed({ _tag: "needs_human" as const, reason }),
    }

    return runWithSteps(
      steps,
      Effect.gen(function* () {
        const db = yield* DbService
        const { created, lifecycle } = yield* driveToReviewNeedsHuman
        yield* persistPaused(created.id)

        const config = yield* db.getConfig
        yield* db.updateConfig({
          selectedAgentBackend: config.selectedAgentBackend,
          defaultModel: config.defaultModel,
          defaultThinkingLevel: config.defaultThinkingLevel,
          reviewModel: config.reviewModel,
          reviewThinkingLevel: config.reviewThinkingLevel,
          maxConcurrentAgentTurns: config.maxConcurrentAgentTurns,
          maxConcurrentWorkItems: 1,
        })

        const holderSeed = yield* seedIssue({
          projectPath: "acme/holder",
          issueNumber: 101,
        })
        const held = yield* lifecycle.implementNow(
          holderSeed.repository.id,
          holderSeed.issue.issueNumber,
        )
        expect(held.holdsWorkerSlot).toBe(true)

        const retried = yield* lifecycle.retry(created.id)
        expect(retried.paused).toBe(false)
        expect(retried.state).toBe("review")
        expect(retried.waitingSince).not.toBeNull()
        expect(retried.holdsWorkerSlot).toBe(false)
        expect(
          retried.stepRuns.filter(
            (run) => run.status === "queued" || run.status === "running",
          ),
        ).toHaveLength(0)

        yield* lifecycle.reset(held.id)
        const afterReset = yield* lifecycle.getWorkItem(created.id)
        if (afterReset.waitingSince !== null) {
          expect(yield* lifecycle.admitWaitingWorkItems).toBeGreaterThan(0)
        }
        const admitted = yield* lifecycle.getWorkItem(created.id)
        expect(admitted.waitingSince).toBeNull()
        expect(admitted.holdsWorkerSlot).toBe(true)
        expect(
          admitted.stepRuns.filter(
            (run) => run.step === "review" && run.status === "queued",
          ),
        ).toHaveLength(1)
      }),
    )
  })

  it("serializes concurrent explicit Retry and keeps Pause when the request is rejected", () => {
    const reason = REVIEW_FIX_LIMIT_REASON
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      review: () => Effect.succeed({ _tag: "needs_human" as const, reason }),
    }

    return runWithSteps(
      steps,
      Effect.gen(function* () {
        const { created, lifecycle } = yield* driveToReviewNeedsHuman
        yield* persistPaused(created.id)

        const autonomousBlocked = yield* Effect.flip(
          lifecycle.retry(created.id, { autonomous: { maxRetries: 3 } }),
        )
        expect(autonomousBlocked).toBeInstanceOf(RetryNotEligibleError)
        if (autonomousBlocked instanceof RetryNotEligibleError) {
          expect(autonomousBlocked.reason).toBe("paused")
        }
        expect((yield* lifecycle.getWorkItem(created.id)).paused).toBe(true)

        const results = yield* Effect.all(
          [
            lifecycle.retry(created.id).pipe(Effect.result),
            lifecycle.retry(created.id).pipe(Effect.result),
          ],
          { concurrency: "unbounded" },
        )
        const successes = results.filter((result) => Result.isSuccess(result))
        const failures = results.filter((result) => Result.isFailure(result))
        expect(successes.length).toBe(1)
        expect(failures.length).toBe(1)
        if (failures[0] !== undefined && Result.isFailure(failures[0])) {
          const error = failures[0].failure
          expect(
            error instanceof ActiveStepRunExistsError ||
              error instanceof RetryNotEligibleError,
          ).toBe(true)
        }

        const after = yield* lifecycle.getWorkItem(created.id)
        expect(after.paused).toBe(false)
        expect(
          after.stepRuns.filter(
            (run) => run.status === "queued" || run.status === "running",
          ),
        ).toHaveLength(1)
      }),
    )
  })

  it("retries a paused Investigate Needs Human handoff and rejects a paused non-retryable handoff", () => {
    const investigateReason = "A repository owner must approve the workflow"
    const decideReason = "A human must decide whether to merge"
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      watchPrStatusChecks: () =>
        Effect.succeed({
          _tag: "handoff_needed" as const,
          createdAt: new Date(0),
          headSha: "settled-head",
          headPushedAt: new Date(0),
          isDraft: false,
        }),
      investigatePrStatusChecks: () =>
        Effect.succeed({
          _tag: "needs_human" as const,
          reason: investigateReason,
          handledCheckIds: [],
        }),
      decidePrMerge: () =>
        Effect.succeed({
          _tag: "needs_human" as const,
          reason: decideReason,
        }),
    }

    return runWithSteps(
      steps,
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const sql = yield* SqlClient.SqlClient
        const investigateSeed = yield* seedIssue({
          projectPath: "acme/investigate",
        })
        yield* lifecycle.implementNow(
          investigateSeed.repository.id,
          investigateSeed.issue.issueNumber,
        )
        for (let index = 0; index < 8; index += 1) {
          yield* claimAndRunPending
        }
        const afterWatch = yield* claimAndRunPending
        expect(afterWatch._tag).toBe("processed")
        if (afterWatch._tag === "processed") {
          expect(afterWatch.workItem.state).toBe("investigate_pr_status_checks")
        }
        const afterInvestigate = yield* claimAndRunPending
        expect(afterInvestigate._tag).toBe("processed")
        if (afterInvestigate._tag !== "processed") {
          return
        }
        expect(afterInvestigate.workItem.state).toBe("needs_human")
        expect(afterInvestigate.workItem.failureMessage).toBe(investigateReason)
        yield* persistPaused(afterInvestigate.workItem.id)

        const retriedInvestigate = yield* lifecycle.retry(
          afterInvestigate.workItem.id,
        )
        expect(retriedInvestigate.paused).toBe(false)
        expect(retriedInvestigate.state).toBe("investigate_pr_status_checks")
        expect(retriedInvestigate.stepRuns.at(-1)).toMatchObject({
          step: "investigate_pr_status_checks",
          status: "queued",
        })

        const decideSeed = yield* seedIssue({
          projectPath: "acme/decide",
          issueNumber: 7,
        })
        const decideItem = yield* lifecycle.implementNow(
          decideSeed.repository.id,
          decideSeed.issue.issueNumber,
        )
        yield* sql.unsafe(
          `UPDATE work_item
           SET state = 'needs_human',
               paused = 1,
               failure_code = 'needs_human',
               failure_message = ?,
               holds_worker_slot = 0
           WHERE id = ?`,
          [decideReason, decideItem.id],
        )
        const latestDecide = decideItem.stepRuns.at(-1)
        if (latestDecide !== undefined) {
          yield* sql.unsafe(
            `UPDATE step_run
             SET step = 'decide_pr_merge',
                 status = 'succeeded',
                 finished_at = ?
             WHERE id = ?`,
            [Date.now(), latestDecide.id],
          )
        }

        const blocked = yield* Effect.flip(lifecycle.retry(decideItem.id))
        expect(
          blocked instanceof WorkItemTerminalError ||
            blocked instanceof RetryNotEligibleError,
        ).toBe(true)
        const stillPaused = yield* lifecycle.getWorkItem(decideItem.id)
        expect(stillPaused.paused).toBe(true)
        expect(stillPaused.state).toBe("needs_human")
        expect(stillPaused.failureMessage).toBe(decideReason)
      }),
    )
  })
})
