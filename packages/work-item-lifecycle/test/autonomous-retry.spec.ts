import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Option, Result } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { DatabaseTest, makeFileDatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import { QueueService } from "@ready-for-agent/queue-service"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
  AutonomousRetryDeferredError,
  AutonomousRetryLimitReachedError,
  DEFAULT_AUTONOMOUS_RETRY_LIMIT,
  LifecycleStepFailedError,
  LifecycleSteps,
  type LifecycleStepsShape,
  WORK_ITEM_LIFECYCLE_QUEUE,
  WorkItemLifecycle,
  WorkItemLifecycleLive,
  stubActiveAgentBackendLayer,
  stubAzureDevOpsServiceLayer,
  stubGitHubServiceLayer,
  stubGitLabServiceLayer,
} from "../src/index.js"
import { describe, expect, it, setDefaultTimeout } from "bun:test"

setDefaultTimeout(30_000)

const successfulSteps: LifecycleStepsShape = {
  createWorktree: () =>
    Effect.succeed({
      worktreePath: "/tmp/worktrees/acme-widgets-42",
      startingCommitOid: "abc123",
    }),
  installDependencies: () => Effect.void,
  implement: () => Effect.succeed("ses_test"),
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
      _tag: "succeeded",
      createdAt: new Date(0),
      headSha: "head",
      headPushedAt: new Date(0),
      isDraft: false,
    }),
  resolvePrMergeConflict: () => Effect.succeed({ _tag: "processed" }),
  investigatePrStatusChecks: () =>
    Effect.succeed({ _tag: "processed", handledCheckIds: [] }),
  markPrReadyForReview: () => Effect.succeed({ completion: "native" as const }),
  decidePrMerge: () => Effect.succeed({ _tag: "clanker_merge" }),
  mergePr: () => Effect.succeed({ _tag: "merged" }),
  closeIssue: () => Effect.void,
  localCleanup: () => Effect.void,
  removeWorktree: () => Effect.void,
}

const failingCreateWorktree = (
  message = "create worktree failed",
): LifecycleStepsShape => ({
  ...successfulSteps,
  createWorktree: () => Effect.fail(new LifecycleStepFailedError({ message })),
})

const sampleRepository = {
  forge: "github" as const,
  forgeHost: "github.com",
  projectPath: "acme/widgets",
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

const makeTestLayer = (steps: LifecycleStepsShape) =>
  WorkItemLifecycleLive.pipe(
    Layer.provideMerge(stubActiveAgentBackendLayer()),
    Layer.provideMerge(stubGitHubServiceLayer()),
    Layer.provideMerge(stubGitLabServiceLayer()),
    Layer.provideMerge(stubAzureDevOpsServiceLayer()),
    Layer.provideMerge(Layer.succeed(LifecycleSteps, LifecycleSteps.of(steps))),
    Layer.provideMerge(DbServiceLive),
    Layer.provideMerge(SqliteQueueServiceLive),
    Layer.provideMerge(DatabaseTest),
  )

const makeRestartLayer = (steps: LifecycleStepsShape, filename: string) =>
  WorkItemLifecycleLive.pipe(
    Layer.provideMerge(stubActiveAgentBackendLayer()),
    Layer.provideMerge(stubGitHubServiceLayer()),
    Layer.provideMerge(stubGitLabServiceLayer()),
    Layer.provideMerge(stubAzureDevOpsServiceLayer()),
    Layer.provideMerge(Layer.succeed(LifecycleSteps, LifecycleSteps.of(steps))),
    Layer.provideMerge(DbServiceLive),
    Layer.provideMerge(SqliteQueueServiceLive),
    Layer.provideMerge(makeFileDatabaseTest(filename)),
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
): Promise<A> => Effect.runPromise(Effect.provide(test, makeTestLayer(steps)))

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

const seedIssue = (issueNumber: number, projectPath = "acme/widgets") =>
  Effect.gen(function* () {
    const db = yield* DbService
    yield* seedHarnessBuildModel
    const repository = yield* db.addRepository({
      ...sampleRepository,
      projectPath,
      localPath: `/repos/${projectPath}.git`,
    })
    const issue = yield* db.storeIssue({
      repositoryId: repository.id,
      issueNumber,
      ...sampleIssueFields,
      url: `https://github.com/${projectPath}/issues/${issueNumber}`,
    })
    return { repository, issue }
  })

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

const failInitialCreateWorktree = Effect.gen(function* () {
  const lifecycle = yield* WorkItemLifecycle
  const { repository, issue } = yield* seedIssue(42)
  const created = yield* lifecycle.implementNow(
    repository.id,
    issue.issueNumber,
  )
  const failed = yield* claimAndRunPending
  expect(failed._tag).toBe("processed")
  return created
})

const countPermits = (workItemId: string, step = "create_worktree") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = (yield* sql.unsafe(
      `SELECT COUNT(*) AS count FROM autonomous_retry
       WHERE work_item_id = ? AND lifecycle_step = ?`,
      [workItemId, step],
    )) as readonly { readonly count: number }[]
    return Number(rows[0]?.count ?? 0)
  })

describe("Autonomous Retry Budget", () => {
  it("does not consume the budget on the initial Step Run", () =>
    runWithSteps(
      failingCreateWorktree(),
      Effect.gen(function* () {
        const created = yield* failInitialCreateWorktree
        expect(created.stepRuns).toHaveLength(1)
        expect(yield* countPermits(created.id)).toBe(0)
      }),
    ))

  it("accepts three Autonomous Retries then reports LIMIT_REACHED without mutating", () =>
    runWithSteps(
      failingCreateWorktree(),
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const created = yield* failInitialCreateWorktree
        const policy = { autonomous: { maxRetries: 3 } }

        for (let attempt = 1; attempt <= 3; attempt += 1) {
          const retried = yield* lifecycle.retry(created.id, policy)
          expect(retried.stepRuns).toHaveLength(attempt + 1)
          expect(yield* countPermits(created.id)).toBe(attempt)
          const ran = yield* claimAndRunPending
          expect(ran._tag).toBe("processed")
        }

        const before = yield* lifecycle.getWorkItem(created.id)
        const blocked = yield* Effect.flip(lifecycle.retry(created.id, policy))
        expect(blocked).toBeInstanceOf(AutonomousRetryLimitReachedError)
        if (blocked instanceof AutonomousRetryLimitReachedError) {
          expect(blocked.used).toBe(3)
          expect(blocked.max).toBe(DEFAULT_AUTONOMOUS_RETRY_LIMIT)
        }
        const after = yield* lifecycle.getWorkItem(created.id)
        expect(after.stepRuns).toHaveLength(before.stepRuns.length)
        expect(after.state).toBe(before.state)
        expect(after.stepRuns.at(-1)?.status).toBe("failed")
      }),
    ))

  it("does not reset the budget when the failure message changes", () =>
    runWithSteps(
      failingCreateWorktree("first message"),
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const created = yield* failInitialCreateWorktree
        const policy = { autonomous: { maxRetries: 1 } }
        yield* lifecycle.retry(created.id, policy)
        yield* claimAndRunPending
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(
          `UPDATE step_run SET reason_message = ? WHERE work_item_id = ?`,
          ["different prose", created.id],
        )
        const blocked = yield* Effect.flip(lifecycle.retry(created.id, policy))
        expect(blocked).toBeInstanceOf(AutonomousRetryLimitReachedError)
      }),
    ))

  it("resets the budget after successful advancement to another Lifecycle Step", () => {
    let createAttempts = 0
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      createWorktree: () => {
        createAttempts += 1
        if (createAttempts === 1) {
          return Effect.fail(
            new LifecycleStepFailedError({ message: "create failed" }),
          )
        }
        return Effect.succeed({
          worktreePath: "/tmp/worktrees/advanced",
          startingCommitOid: "abc123",
        })
      },
      installDependencies: () =>
        Effect.fail(
          new LifecycleStepFailedError({ message: "install failed" }),
        ),
    }

    return runWithSteps(
      steps,
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const created = yield* failInitialCreateWorktree
        const policy = { autonomous: { maxRetries: 1 } }

        yield* lifecycle.retry(created.id, policy)
        const afterCreate = yield* claimAndRunPending
        expect(afterCreate._tag).toBe("processed")
        if (afterCreate._tag === "processed") {
          expect(afterCreate.workItem.state).toBe("install_dependencies")
        }
        expect(yield* countPermits(created.id, "create_worktree")).toBe(1)

        const installFailed = yield* claimAndRunPending
        expect(installFailed._tag).toBe("processed")

        const retriedInstall = yield* lifecycle.retry(created.id, policy)
        expect(retriedInstall.stepRuns.at(-1)?.step).toBe(
          "install_dependencies",
        )
        expect(yield* countPermits(created.id, "install_dependencies")).toBe(1)
      }),
    )
  })

  it("lets an operator Retry proceed after Autonomous Retry Budget exhaustion", () =>
    runWithSteps(
      failingCreateWorktree(),
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const created = yield* failInitialCreateWorktree
        const policy = { autonomous: { maxRetries: 0 } }
        const blocked = yield* Effect.flip(lifecycle.retry(created.id, policy))
        expect(blocked).toBeInstanceOf(AutonomousRetryLimitReachedError)

        const manual = yield* lifecycle.retry(created.id)
        expect(manual.stepRuns).toHaveLength(2)
        expect(manual.stepRuns.at(-1)?.status).toBe("queued")
        expect(yield* countPermits(created.id)).toBe(0)
      }),
    ))

  it("does not consume a permit while only Waiting for Worker Slot", () =>
    runWithSteps(
      failingCreateWorktree(),
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const db = yield* DbService
        const created = yield* failInitialCreateWorktree

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

        const holder = yield* seedIssue(101, "acme/holder")
        const held = yield* lifecycle.implementNow(
          holder.repository.id,
          holder.issue.issueNumber,
        )
        expect(held.holdsWorkerSlot).toBe(true)

        const retried = yield* lifecycle.retry(created.id, {
          autonomous: { maxRetries: 1 },
        })
        expect(retried.waitingSince).not.toBeNull()
        expect(retried.stepRuns).toHaveLength(1)
        expect(yield* countPermits(created.id)).toBe(0)

        yield* lifecycle.reset(held.id)
        const afterReset = yield* lifecycle.getWorkItem(created.id)
        if (afterReset.waitingSince !== null) {
          expect(yield* lifecycle.admitWaitingWorkItems).toBeGreaterThan(0)
        }
        const afterAdmit = yield* lifecycle.getWorkItem(created.id)
        expect(afterAdmit.waitingSince).toBeNull()
        expect(afterAdmit.stepRuns).toHaveLength(2)
        expect(yield* countPermits(created.id)).toBe(1)
      }),
    ))

  it("serializes concurrent Autonomous Retries so they cannot exceed the budget", () =>
    runWithSteps(
      failingCreateWorktree(),
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const created = yield* failInitialCreateWorktree
        const policy = { autonomous: { maxRetries: 1 } }

        const results = yield* Effect.all(
          [
            lifecycle.retry(created.id, policy).pipe(Effect.result),
            lifecycle.retry(created.id, policy).pipe(Effect.result),
          ],
          { concurrency: "unbounded" },
        )

        const successes = results.filter((result) => Result.isSuccess(result))
        expect(successes.length).toBe(1)
        expect(yield* countPermits(created.id)).toBe(1)
        const after = yield* lifecycle.getWorkItem(created.id)
        expect(
          after.stepRuns.filter(
            (run) => run.status === "queued" || run.status === "running",
          ),
        ).toHaveLength(1)
      }),
    ))

  it("survives harness restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rfa-autonomous-retry-"))
    const dbPath = join(dir, "restart.db")
    const steps = failingCreateWorktree()
    try {
      const workItemId = await Effect.runPromise(
        Effect.gen(function* () {
          const created = yield* failInitialCreateWorktree
          const lifecycle = yield* WorkItemLifecycle
          yield* lifecycle.retry(created.id, {
            autonomous: { maxRetries: 1 },
          })
          yield* claimAndRunPending
          return created.id
        }).pipe(Effect.provide(makeRestartLayer(steps, dbPath))),
      )

      const blocked = await Effect.runPromise(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          return yield* Effect.flip(
            lifecycle.retry(workItemId, { autonomous: { maxRetries: 1 } }),
          )
        }).pipe(Effect.provide(makeRestartLayer(steps, dbPath))),
      )
      expect(blocked).toBeInstanceOf(AutonomousRetryLimitReachedError)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("defers Autonomous Retry when a future provider hold is persisted", () =>
    runWithSteps(
      failingCreateWorktree(),
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const created = yield* failInitialCreateWorktree
        const retryAt = Date.now() + 60_000
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(
          `UPDATE step_run
           SET reason_detail = ?
           WHERE id = ?`,
          [
            JSON.stringify({
              causeChain: [],
              retryAt: new Date(retryAt).toISOString(),
            }),
            created.stepRuns[0]!.id,
          ],
        )

        const deferred = yield* Effect.flip(
          lifecycle.retry(created.id, { autonomous: { maxRetries: 3 } }),
        )
        expect(deferred).toBeInstanceOf(AutonomousRetryDeferredError)
        if (deferred instanceof AutonomousRetryDeferredError) {
          expect(deferred.retryAt).toBe(
            Date.parse(new Date(retryAt).toISOString()),
          )
        }
        const after = yield* lifecycle.getWorkItem(created.id)
        expect(after.stepRuns).toHaveLength(1)
        expect(yield* countPermits(created.id)).toBe(0)
      }),
    ))

  it("retries after an expired provider hold", () =>
    runWithSteps(
      failingCreateWorktree(),
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const created = yield* failInitialCreateWorktree
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(
          `UPDATE step_run
           SET reason_detail = ?
           WHERE id = ?`,
          [
            JSON.stringify({
              causeChain: [],
              retryAt: new Date(Date.now() - 1_000).toISOString(),
            }),
            created.stepRuns[0]!.id,
          ],
        )
        const retried = yield* lifecycle.retry(created.id, {
          autonomous: { maxRetries: 3 },
        })
        expect(retried.stepRuns).toHaveLength(2)
        expect(yield* countPermits(created.id)).toBe(1)
      }),
    ))

  it("follows the ordinary budget when retry-time data is absent", () =>
    runWithSteps(
      failingCreateWorktree(),
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const created = yield* failInitialCreateWorktree
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(
          `UPDATE step_run
           SET reason_detail = ?
           WHERE id = ?`,
          [
            JSON.stringify({
              causeChain: [{ message: "rate limited, try later" }],
            }),
            created.stepRuns[0]!.id,
          ],
        )
        const retried = yield* lifecycle.retry(created.id, {
          autonomous: { maxRetries: 3 },
        })
        expect(retried.stepRuns).toHaveLength(2)
        expect(yield* countPermits(created.id)).toBe(1)
      }),
    ))
})
