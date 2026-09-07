import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Fiber, Layer, Option } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { DatabaseTest, makeFileDatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import { QueueService } from "@ready-for-agent/queue-service"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
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

const settledTiming = {
  createdAt: new Date(0),
  headSha: "settled-head",
  headPushedAt: new Date(0),
  isDraft: false,
} as const

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
      _tag: "succeeded",
      ...settledTiming,
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

const makeTestLayer = (
  steps: LifecycleStepsShape = successfulSteps,
  filename?: string,
) =>
  WorkItemLifecycleLive.pipe(
    Layer.provideMerge(stubActiveAgentBackendLayer()),
    Layer.provideMerge(stubGitHubServiceLayer()),
    Layer.provideMerge(stubGitLabServiceLayer()),
    Layer.provideMerge(stubAzureDevOpsServiceLayer()),
    Layer.provideMerge(Layer.succeed(LifecycleSteps, LifecycleSteps.of(steps))),
    Layer.provideMerge(DbServiceLive),
    Layer.provideMerge(SqliteQueueServiceLive),
    Layer.provideMerge(
      filename === undefined ? DatabaseTest : makeFileDatabaseTest(filename),
    ),
  )

type TestRequirements = Layer.Layer.Success<ReturnType<typeof makeTestLayer>>

const runWithSteps = <A, E>(
  steps: LifecycleStepsShape,
  test: Effect.Effect<A, E, TestRequirements>,
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

const seedActionableIssue = Effect.gen(function* () {
  const db = yield* DbService
  yield* seedHarnessBuildModel
  const repository = yield* db.addRepository(sampleRepository)
  const issue = yield* db.storeIssue({
    repositoryId: repository.id,
    issueNumber: 42,
    ...sampleIssueFields,
  })
  return { repository, issue }
})

const setMergePolicy = (repositoryId: string, policy: "classify" | "always") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(`UPDATE repository SET merge_policy = ? WHERE id = ?`, [
      policy,
      repositoryId,
    ])
  })

const setMaxWorkItems = (maxConcurrentWorkItems: number) =>
  Effect.gen(function* () {
    const db = yield* DbService
    const config = yield* db.getConfig
    yield* db.updateConfig({
      selectedAgentBackend: "opencode",
      defaultModel: config.defaultModel ?? "opencode/deepseek-v4-flash-free",
      defaultThinkingLevel: config.defaultThinkingLevel ?? "low",
      reviewModel: config.reviewModel,
      reviewThinkingLevel: config.reviewThinkingLevel,
      maxConcurrentAgentTurns: config.maxConcurrentAgentTurns,
      maxConcurrentWorkItems,
    })
  })

const seedSiblingIssue = (repositoryId: string, issueNumber: number) =>
  Effect.gen(function* () {
    const db = yield* DbService
    return yield* db.storeIssue({
      repositoryId,
      issueNumber,
      ...sampleIssueFields,
      url: `https://github.com/acme/widgets/issues/${issueNumber}`,
    })
  })

const closeCiGate = (repositoryId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const now = Date.now()
    yield* sql.unsafe(
      `INSERT INTO ci_gate_definition_observation (
         id, repository_id, definition_identity, failure_latched,
         last_raw_status, last_raw_conclusion, created_at, updated_at
       ) VALUES (?, ?, '161335', 1, 'completed', 'failure', ?, ?)
       ON CONFLICT(repository_id, definition_identity) DO UPDATE SET
         failure_latched = 1,
         last_raw_status = 'completed',
         last_raw_conclusion = 'failure',
         updated_at = excluded.updated_at`,
      [`cgo-${repositoryId.slice(-8)}`, repositoryId, now, now],
    )
  })

const openCiGate = (repositoryId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(
      `DELETE FROM ci_gate_definition_observation WHERE repository_id = ?`,
      [repositoryId],
    )
  })

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
  return yield* lifecycle.runStep(
    (claimed.value.payload as { stepRunId: string }).stepRunId,
  )
})

const driveThroughCreatePr = (workItemId: string) =>
  Effect.gen(function* () {
    for (let index = 0; index < 8; index += 1) {
      const result = yield* claimAndRunPending
      expect(result._tag).toBe("processed")
    }
    yield* forgetCreatePrDraftProvenance(workItemId)
  })

describe("Waiting for CI Repair merge hold", () => {
  it("holds a Classify CLANKER_MERGE at Merge PR without a Step Run or Worker Slot", () =>
    runWithSteps(
      successfulSteps,
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const { repository, issue } = yield* seedActionableIssue
        yield* setMergePolicy(repository.id, "classify")
        const created = yield* lifecycle.implementNow(
          repository.id,
          issue.issueNumber,
        )
        yield* closeCiGate(repository.id)
        yield* driveThroughCreatePr(created.id)

        const afterWatch = yield* claimAndRunPending
        expect(afterWatch._tag).toBe("processed")
        if (afterWatch._tag === "processed") {
          expect(afterWatch.workItem.state).toBe("decide_pr_merge")
        }

        const afterDecide = yield* claimAndRunPending
        expect(afterDecide._tag).toBe("processed")
        if (afterDecide._tag !== "processed") {
          return
        }
        expect(afterDecide.workItem.state).toBe("merge_pr")
        expect(afterDecide.workItem.waitingForCiRepair).toBe(true)
        expect(afterDecide.workItem.holdsWorkerSlot).toBe(false)
        expect(afterDecide.workItem.waitingSince).toBeNull()
        expect(afterDecide.workItem.paused).toBe(false)
        expect(
          afterDecide.workItem.stepRuns.some((run) => run.step === "merge_pr"),
        ).toBe(false)

        const queue = yield* QueueService
        const remaining = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
        expect(Option.isNone(remaining)).toBe(true)
      }),
    ))

  it("holds Always merge routing at Merge PR without changing Always semantics", () =>
    runWithSteps(
      successfulSteps,
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const { repository, issue } = yield* seedActionableIssue
        yield* setMergePolicy(repository.id, "always")
        const created = yield* lifecycle.implementNow(
          repository.id,
          issue.issueNumber,
        )
        yield* closeCiGate(repository.id)
        yield* driveThroughCreatePr(created.id)

        const afterWatch = yield* claimAndRunPending
        expect(afterWatch._tag).toBe("processed")
        if (afterWatch._tag !== "processed") {
          return
        }
        expect(afterWatch.workItem.state).toBe("merge_pr")
        expect(afterWatch.workItem.waitingForCiRepair).toBe(true)
        expect(afterWatch.workItem.holdsWorkerSlot).toBe(false)
        expect(
          afterWatch.workItem.stepRuns.some((run) => run.step === "merge_pr"),
        ).toBe(false)
        expect(
          afterWatch.workItem.stepRuns.some(
            (run) => run.step === "decide_pr_merge",
          ),
        ).toBe(false)
      }),
    ))

  it("does not hold when the cached gate is Open", () =>
    runWithSteps(
      successfulSteps,
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const { repository, issue } = yield* seedActionableIssue
        yield* setMergePolicy(repository.id, "classify")

        const created = yield* lifecycle.implementNow(
          repository.id,
          issue.issueNumber,
        )
        yield* driveThroughCreatePr(created.id)
        yield* claimAndRunPending
        const afterDecide = yield* claimAndRunPending
        expect(afterDecide._tag).toBe("processed")
        if (afterDecide._tag === "processed") {
          expect(afterDecide.workItem.state).toBe("merge_pr")
          expect(afterDecide.workItem.waitingForCiRepair).toBe(false)
          expect(afterDecide.workItem.holdsWorkerSlot).toBe(true)
          expect(
            afterDecide.workItem.stepRuns.some(
              (run) => run.step === "merge_pr",
            ),
          ).toBe(true)
        }
      }),
    ))

  it("converts a queued Merge PR Step Run to the hold before any Forge mutation", () => {
    let mergeCalls = 0
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      mergePr: () =>
        Effect.sync(() => {
          mergeCalls += 1
          return { _tag: "merged" as const }
        }),
    }
    return runWithSteps(
      steps,
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const { repository, issue } = yield* seedActionableIssue
        yield* setMergePolicy(repository.id, "classify")

        const created = yield* lifecycle.implementNow(
          repository.id,
          issue.issueNumber,
        )
        yield* driveThroughCreatePr(created.id)
        yield* claimAndRunPending
        const afterDecide = yield* claimAndRunPending
        expect(afterDecide._tag).toBe("processed")
        if (afterDecide._tag === "processed") {
          expect(afterDecide.workItem.state).toBe("merge_pr")
          expect(afterDecide.workItem.waitingForCiRepair).toBe(false)
          expect(
            afterDecide.workItem.stepRuns.some(
              (run) => run.step === "merge_pr" && run.status === "queued",
            ),
          ).toBe(true)
        }

        yield* closeCiGate(repository.id)
        const afterHold = yield* claimAndRunPending
        expect(afterHold._tag).toBe("processed")
        if (afterHold._tag !== "processed") {
          return
        }
        expect(afterHold.workItem.state).toBe("merge_pr")
        expect(afterHold.workItem.waitingForCiRepair).toBe(true)
        expect(afterHold.workItem.holdsWorkerSlot).toBe(false)
        expect(mergeCalls).toBe(0)
        expect(
          afterHold.workItem.stepRuns.some(
            (run) => run.step === "merge_pr" && run.status === "succeeded",
          ),
        ).toBe(false)
      }),
    )
  })

  it("lets an in-flight Forge merge mutation finish after the gate closes", () =>
    Effect.gen(function* () {
      const mergeStarted = yield* Deferred.make<void>()
      const mergeResult = yield* Deferred.make<{
        readonly _tag: "merged"
      }>()
      const steps: LifecycleStepsShape = {
        ...successfulSteps,
        mergePr: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(mergeStarted, undefined)
            return yield* Deferred.await(mergeResult)
          }),
      }
      return yield* Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const { repository, issue } = yield* seedActionableIssue
        yield* setMergePolicy(repository.id, "classify")

        const created = yield* lifecycle.implementNow(
          repository.id,
          issue.issueNumber,
        )
        yield* driveThroughCreatePr(created.id)
        yield* claimAndRunPending
        yield* claimAndRunPending

        const mergeFiber = yield* Effect.forkChild(claimAndRunPending)
        yield* Deferred.await(mergeStarted)
        yield* closeCiGate(repository.id)
        yield* Deferred.succeed(mergeResult, { _tag: "merged" })
        const afterMerge = yield* Fiber.join(mergeFiber)
        expect(afterMerge._tag).toBe("processed")
        if (afterMerge._tag !== "processed") {
          return
        }
        expect(afterMerge.workItem.state).toBe("local_cleanup")
        expect(afterMerge.workItem.waitingForCiRepair).toBe(false)
        expect(
          afterMerge.workItem.stepRuns.some(
            (run) => run.step === "merge_pr" && run.status === "succeeded",
          ),
        ).toBe(true)
      }).pipe(Effect.provide(makeTestLayer(steps)))
    }).pipe(Effect.scoped, Effect.runPromise))

  it("wakes held work into ordinary FIFO admission and revalidates before merge", () => {
    let mergeCalls = 0
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      mergePr: () =>
        Effect.sync(() => {
          mergeCalls += 1
          return { _tag: "merged" as const }
        }),
    }
    return runWithSteps(
      steps,
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const { repository, issue } = yield* seedActionableIssue
        yield* setMergePolicy(repository.id, "classify")
        const created = yield* lifecycle.implementNow(
          repository.id,
          issue.issueNumber,
        )
        yield* closeCiGate(repository.id)
        yield* driveThroughCreatePr(created.id)
        yield* claimAndRunPending
        const held = yield* claimAndRunPending
        expect(held._tag).toBe("processed")
        if (held._tag === "processed") {
          expect(held.workItem.waitingForCiRepair).toBe(true)
        }

        yield* openCiGate(repository.id)
        expect(yield* lifecycle.releaseWaitingForCiRepair(repository.id)).toBe(
          1,
        )

        const woken = yield* lifecycle.getWorkItem(created.id)
        expect(woken.waitingForCiRepair).toBe(false)
        expect(woken.holdsWorkerSlot).toBe(true)
        expect(woken.state).toBe("merge_pr")
        expect(woken.paused).toBe(false)

        const afterMerge = yield* claimAndRunPending
        expect(afterMerge._tag).toBe("processed")
        if (afterMerge._tag === "processed") {
          expect(afterMerge.workItem.state).toBe("local_cleanup")
        }
        expect(mergeCalls).toBe(1)
      }),
    )
  })

  it("does not take a free Worker Slot ahead of existing waiters when the gate reopens", () =>
    runWithSteps(
      successfulSteps,
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const { repository, issue } = yield* seedActionableIssue
        yield* setMergePolicy(repository.id, "classify")
        const created = yield* lifecycle.implementNow(
          repository.id,
          issue.issueNumber,
        )
        yield* closeCiGate(repository.id)
        yield* driveThroughCreatePr(created.id)
        yield* claimAndRunPending
        const held = yield* claimAndRunPending
        expect(held._tag).toBe("processed")
        if (held._tag === "processed") {
          expect(held.workItem.waitingForCiRepair).toBe(true)
          expect(held.workItem.holdsWorkerSlot).toBe(false)
        }

        yield* setMaxWorkItems(1)
        const occupyingIssue = yield* seedSiblingIssue(repository.id, 43)
        const occupying = yield* lifecycle.implementLocally(
          repository.id,
          occupyingIssue.issueNumber,
        )
        expect(occupying.holdsWorkerSlot).toBe(true)

        const waiterIssue = yield* seedSiblingIssue(repository.id, 44)
        const waiter = yield* lifecycle.implementLocally(
          repository.id,
          waiterIssue.issueNumber,
        )
        expect(waiter.holdsWorkerSlot).toBe(false)
        expect(waiter.waitingSince).not.toBeNull()

        yield* setMaxWorkItems(2)
        yield* openCiGate(repository.id)
        expect(yield* lifecycle.releaseWaitingForCiRepair(repository.id)).toBe(
          1,
        )

        const admittedWaiter = yield* lifecycle.getWorkItem(waiter.id)
        const recovered = yield* lifecycle.getWorkItem(created.id)
        expect(admittedWaiter.holdsWorkerSlot).toBe(true)
        expect(admittedWaiter.waitingSince).toBeNull()
        expect(recovered.waitingForCiRepair).toBe(false)
        expect(recovered.holdsWorkerSlot).toBe(false)
        expect(recovered.waitingSince).not.toBeNull()
        expect(recovered.state).toBe("merge_pr")
        expect(
          recovered.stepRuns.some(
            (run) => run.step === "merge_pr" && run.status === "queued",
          ),
        ).toBe(false)
      }),
    ))

  it("does not start a paused Work Item when the gate reopens", () =>
    runWithSteps(
      successfulSteps,
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const { repository, issue } = yield* seedActionableIssue
        yield* setMergePolicy(repository.id, "classify")
        const created = yield* lifecycle.implementNow(
          repository.id,
          issue.issueNumber,
        )
        yield* closeCiGate(repository.id)
        yield* driveThroughCreatePr(created.id)
        yield* claimAndRunPending
        const held = yield* claimAndRunPending
        expect(held._tag).toBe("processed")
        if (held._tag === "processed") {
          expect(held.workItem.waitingForCiRepair).toBe(true)
        }

        const paused = yield* lifecycle.pause(created.id)
        expect(paused.paused).toBe(true)

        yield* openCiGate(repository.id)
        expect(yield* lifecycle.releaseWaitingForCiRepair(repository.id)).toBe(
          1,
        )

        const afterWake = yield* lifecycle.getWorkItem(created.id)
        expect(afterWake.paused).toBe(true)
        expect(afterWake.waitingForCiRepair).toBe(false)
        expect(afterWake.holdsWorkerSlot).toBe(false)
        expect(afterWake.state).toBe("merge_pr")
        expect(
          afterWake.stepRuns.some(
            (run) => run.step === "merge_pr" && run.status === "queued",
          ),
        ).toBe(false)
      }),
    ))

  it("returns a changed head to Watch PR Status Checks after resume", () => {
    let mergeCalls = 0
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      mergePr: () =>
        Effect.sync(() => {
          mergeCalls += 1
          return {
            _tag: "revalidation" as const,
            reason: "head_changed" as const,
            message: "PR head changed",
          }
        }),
    }
    return runWithSteps(
      steps,
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const { repository, issue } = yield* seedActionableIssue
        yield* setMergePolicy(repository.id, "classify")
        const created = yield* lifecycle.implementNow(
          repository.id,
          issue.issueNumber,
        )
        yield* closeCiGate(repository.id)
        yield* driveThroughCreatePr(created.id)
        yield* claimAndRunPending
        yield* claimAndRunPending

        yield* openCiGate(repository.id)
        yield* lifecycle.releaseWaitingForCiRepair(repository.id)
        const afterMerge = yield* claimAndRunPending
        expect(afterMerge._tag).toBe("processed")
        if (afterMerge._tag === "processed") {
          expect(afterMerge.workItem.state).toBe("watch_pr_status_checks")
        }
        expect(mergeCalls).toBe(1)
      }),
    )
  })

  it("returns a conflict, including after a CI repair, to Resolve PR Merge Conflict", () => {
    let watchCalls = 0
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      mergePr: () =>
        Effect.succeed({
          _tag: "revalidation" as const,
          reason: "mergeability_changed" as const,
          message: "PR is conflicting",
        }),
      watchPrStatusChecks: () => {
        watchCalls += 1
        if (watchCalls > 1) {
          return Effect.succeed({
            _tag: "conflict" as const,
            retiredCheckIds: [],
            ...settledTiming,
          })
        }
        return Effect.succeed({
          _tag: "succeeded" as const,
          ...settledTiming,
        })
      },
    }
    return runWithSteps(
      steps,
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const { repository, issue } = yield* seedActionableIssue
        yield* setMergePolicy(repository.id, "classify")
        const created = yield* lifecycle.implementNow(
          repository.id,
          issue.issueNumber,
        )
        yield* closeCiGate(repository.id)
        yield* driveThroughCreatePr(created.id)
        yield* claimAndRunPending
        yield* claimAndRunPending

        yield* openCiGate(repository.id)
        yield* lifecycle.releaseWaitingForCiRepair(repository.id)
        const afterMerge = yield* claimAndRunPending
        expect(afterMerge._tag).toBe("processed")
        if (afterMerge._tag === "processed") {
          expect(afterMerge.workItem.state).toBe("watch_pr_status_checks")
        }
        const afterWatch = yield* claimAndRunPending
        expect(afterWatch._tag).toBe("processed")
        if (afterWatch._tag === "processed") {
          expect(afterWatch.workItem.state).toBe("resolve_pr_merge_conflict")
        }
      }),
    )
  })

  it("preserves the hold across restart", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() =>
        mkdtemp(join(tmpdir(), "ci-gate-merge-hold-")),
      )
      const filename = join(dir, "harness.sqlite")
      try {
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            const lifecycle = yield* WorkItemLifecycle
            const { repository, issue } = yield* seedActionableIssue
            yield* setMergePolicy(repository.id, "classify")
            const created = yield* lifecycle.implementNow(
              repository.id,
              issue.issueNumber,
            )
            yield* closeCiGate(repository.id)
            yield* driveThroughCreatePr(created.id)
            yield* claimAndRunPending
            const held = yield* claimAndRunPending
            expect(held._tag).toBe("processed")
            if (held._tag !== "processed") {
              return yield* Effect.die("expected hold")
            }
            expect(held.workItem.waitingForCiRepair).toBe(true)
            expect(held.workItem.holdsWorkerSlot).toBe(false)
            return {
              workItemId: held.workItem.id,
              repositoryId: repository.id,
            }
          }).pipe(Effect.provide(makeTestLayer(successfulSteps, filename))),
        )

        const second = yield* Effect.scoped(
          Effect.gen(function* () {
            const lifecycle = yield* WorkItemLifecycle
            const reloaded = yield* lifecycle.getWorkItem(first.workItemId)
            expect(reloaded.state).toBe("merge_pr")
            expect(reloaded.waitingForCiRepair).toBe(true)
            expect(reloaded.holdsWorkerSlot).toBe(false)
            expect(
              reloaded.stepRuns.some((run) => run.step === "merge_pr"),
            ).toBe(false)

            yield* openCiGate(first.repositoryId)
            expect(
              yield* lifecycle.releaseWaitingForCiRepair(first.repositoryId),
            ).toBe(1)
            const woken = yield* lifecycle.getWorkItem(first.workItemId)
            expect(woken.waitingForCiRepair).toBe(false)
            expect(woken.holdsWorkerSlot).toBe(true)
            return woken.state
          }).pipe(Effect.provide(makeTestLayer(successfulSteps, filename))),
        )
        expect(second).toBe("merge_pr")
      } finally {
        yield* Effect.promise(() => rm(dir, { recursive: true, force: true }))
      }
    }).pipe(Effect.runPromise))

  it("clears the hold and resumes local cleanup after a human merge while Closed", () => {
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      mergePr: () =>
        Effect.die("merge must not run after human merge during CI hold"),
    }
    return runWithSteps(
      steps,
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const { repository, issue } = yield* seedActionableIssue
        yield* setMergePolicy(repository.id, "classify")
        const created = yield* lifecycle.implementNow(
          repository.id,
          issue.issueNumber,
        )
        yield* closeCiGate(repository.id)
        yield* driveThroughCreatePr(created.id)
        yield* claimAndRunPending
        const held = yield* claimAndRunPending
        expect(held._tag).toBe("processed")
        if (held._tag !== "processed") {
          return
        }
        expect(held.workItem.state).toBe("merge_pr")
        expect(held.workItem.waitingForCiRepair).toBe(true)
        expect(held.workItem.holdsWorkerSlot).toBe(false)
        expect(held.workItem.pullRequestNumber).toBe(101)

        const resumed = yield* lifecycle.continueAfterHumanPrOutcome(
          created.id,
          "merged",
        )
        expect(resumed.state).toBe("local_cleanup")
        expect(resumed.waitingForCiRepair).toBe(false)
        expect(resumed.holdsWorkerSlot).toBe(true)
        expect(resumed.paused).toBe(false)
        expect(resumed.stepRuns.some((run) => run.step === "merge_pr")).toBe(
          false,
        )

        const afterCleanup = yield* claimAndRunPending
        expect(afterCleanup._tag).toBe("processed")
        if (afterCleanup._tag === "processed") {
          expect(afterCleanup.workItem.state).toBe("complete")
          expect(afterCleanup.workItem.waitingForCiRepair).toBe(false)
          expect(
            afterCleanup.workItem.stepRuns.some(
              (run) =>
                run.step === "local_cleanup" && run.status === "succeeded",
            ),
          ).toBe(true)
        }
      }),
    )
  })
})
