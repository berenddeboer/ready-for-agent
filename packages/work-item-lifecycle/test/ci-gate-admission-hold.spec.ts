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
      createdAt: new Date(0),
      headSha: "settled-head",
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

const implementWithProfile = {
  agentBackendId: "opencode",
  buildModel: "build-model",
  buildThinkingLevel: "high",
  reviewSameAsBuild: true,
  reviewModel: null,
  reviewThinkingLevel: null,
} as const

const makeTestLayer = (
  steps: LifecycleStepsShape = successfulSteps,
  filename?: string,
) =>
  WorkItemLifecycleLive.pipe(
    Layer.provideMerge(
      stubActiveAgentBackendLayer({
        models: [
          { id: "build-model", thinkingLevels: ["high"] },
          {
            id: "opencode/deepseek-v4-flash-free",
            thinkingLevels: ["low", "high"],
          },
        ],
      }),
    ),
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

const expectPreAdmissionHold = (workItem: {
  readonly state: string
  readonly waitingForCiRepair: boolean
  readonly holdsWorkerSlot: boolean
  readonly waitingSince: Date | null
  readonly waitingForBlockers: boolean
  readonly paused: boolean
  readonly stepRuns: readonly unknown[]
}) => {
  expect(workItem.state).toBe("create_worktree")
  expect(workItem.waitingForCiRepair).toBe(true)
  expect(workItem.holdsWorkerSlot).toBe(false)
  expect(workItem.waitingSince).toBeNull()
  expect(workItem.waitingForBlockers).toBe(false)
  expect(workItem.paused).toBe(false)
  expect(workItem.stepRuns).toHaveLength(0)
}

describe("Waiting for CI Repair pre-admission hold", () => {
  it("holds Implement Now without a Worker Slot or Step Run", () =>
    runWithSteps(
      successfulSteps,
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const queue = yield* QueueService
        const { repository, issue } = yield* seedActionableIssue
        yield* closeCiGate(repository.id)

        const created = yield* lifecycle.implementNow(
          repository.id,
          issue.issueNumber,
        )
        expectPreAdmissionHold(created)
        expect(created.executionProfile).toBeNull()
        expect(created.mergeMode).toBe("ordinary")
        expect(created.autoMergeOverride).toBeNull()
        expect(created.pauseBeforeStep).toBeNull()
        expect(
          Option.isNone(yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)),
        ).toBe(true)
      }),
    ))

  it("holds Implement With and keeps the execution profile and Merge Policy pin", () =>
    runWithSteps(
      successfulSteps,
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const { repository, issue } = yield* seedActionableIssue
        yield* closeCiGate(repository.id)

        const created = yield* lifecycle.implementWith(
          repository.id,
          issue.issueNumber,
          implementWithProfile,
          { mergePolicy: "always" },
        )
        expect(created).toHaveLength(1)
        const workItem = created[0]
        if (workItem === undefined) {
          return yield* Effect.die("expected Implement With Work Item")
        }
        expectPreAdmissionHold(workItem)
        expect(workItem.executionProfile).toEqual({
          agentBackend: "opencode",
          build: { model: "build-model", thinkingLevel: "high" },
          review: { kind: "same_as_build" },
        })
        expect(workItem.mergeMode).toBe("always")
        expect(workItem.pauseBeforeStep).toBeNull()
      }),
    ))

  it("holds parent Implement All children without authorizing CI Repair", () =>
    runWithSteps(
      successfulSteps,
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const db = yield* DbService
        yield* seedHarnessBuildModel
        const repository = yield* db.addRepository({
          ...sampleRepository,
          localPath: "/repos/acme/widgets-parent.git",
          projectPath: "acme/widgets-parent",
        })
        yield* db.storeIssue({
          repositoryId: repository.id,
          issueNumber: 100,
          ...sampleIssueFields,
          title: "Parent feature",
          url: "https://github.com/acme/widgets/issues/100",
          hasChildren: true,
        })
        yield* db.storeIssue({
          repositoryId: repository.id,
          issueNumber: 101,
          ...sampleIssueFields,
          title: "Child work",
          url: "https://github.com/acme/widgets/issues/101",
          parent: {
            issueNumber: 100,
            issueUrl: "https://github.com/acme/widgets/issues/100",
          },
          parentPosition: 0,
        })
        yield* db.storeIssue({
          repositoryId: repository.id,
          issueNumber: 102,
          ...sampleIssueFields,
          title: "Blocked child",
          url: "https://github.com/acme/widgets/issues/102",
          parent: {
            issueNumber: 100,
            issueUrl: "https://github.com/acme/widgets/issues/100",
          },
          parentPosition: 1,
          blockedBy: [
            {
              issueNumber: 1,
              issueUrl: "https://github.com/acme/widgets/issues/1",
            },
          ],
        })
        yield* closeCiGate(repository.id)

        const covered = yield* lifecycle.implementAllWithAutoMerge(
          repository.id,
          100,
        )
        expect(covered).toHaveLength(2)
        const actionable = covered.find((item) => item.issueNumber === 101)
        const blocked = covered.find((item) => item.issueNumber === 102)
        if (actionable === undefined || blocked === undefined) {
          return yield* Effect.die("expected both children")
        }
        expectPreAdmissionHold(actionable)
        expect(actionable.mergeMode).toBe("always")
        expect(actionable.executionProfile).toBeNull()
        expect(blocked.waitingForBlockers).toBe(true)
        expect(blocked.waitingForCiRepair).toBe(false)
        expect(blocked.holdsWorkerSlot).toBe(false)
        expect(blocked.stepRuns).toHaveLength(0)
        expect(blocked.mergeMode).toBe("always")
      }),
    ))

  it("keeps a blocked Queue Work Item waiting for blockers until they clear", () =>
    runWithSteps(
      successfulSteps,
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const db = yield* DbService
        yield* seedHarnessBuildModel
        const repository = yield* db.addRepository({
          ...sampleRepository,
          localPath: "/repos/acme/widgets-blocked.git",
          projectPath: "acme/widgets-blocked",
        })
        const issue = yield* db.storeIssue({
          repositoryId: repository.id,
          issueNumber: 77,
          ...sampleIssueFields,
          title: "Blocked leaf",
          url: "https://github.com/acme/widgets/issues/77",
          blockedBy: [
            {
              issueNumber: 12,
              issueUrl: "https://github.com/acme/widgets/issues/12",
            },
          ],
        })
        yield* closeCiGate(repository.id)

        const held = yield* lifecycle.queue(repository.id, issue.issueNumber)
        expect(held.waitingForBlockers).toBe(true)
        expect(held.waitingForCiRepair).toBe(false)
        expect(held.holdsWorkerSlot).toBe(false)
        expect(held.stepRuns).toHaveLength(0)

        yield* db.storeIssue({
          repositoryId: repository.id,
          issueNumber: issue.issueNumber,
          ...sampleIssueFields,
          title: issue.title,
          url: issue.url,
          blockedBy: [],
        })
        expect(yield* lifecycle.releaseWaitingForBlockers(repository.id)).toBe(
          1,
        )

        const afterBlockers = yield* lifecycle.getWorkItem(held.id)
        expect(afterBlockers.waitingForBlockers).toBe(false)
        expectPreAdmissionHold(afterBlockers)
      }),
    ))

  it("holds Retry of ordinary remote work without creating a Step Run", () => {
    let createCalls = 0
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      createWorktree: () => {
        createCalls += 1
        if (createCalls === 1) {
          return Effect.die("injected create worktree failure")
        }
        return Effect.succeed({
          worktreePath: "/tmp/worktrees/acme-widgets-42",
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
          issue.issueNumber,
        )
        const failed = yield* claimAndRunPending
        expect(failed._tag).toBe("processed")
        if (failed._tag === "processed") {
          expect(failed.workItem.stepRuns[0]?.status).toBe("failed")
        }

        yield* closeCiGate(repository.id)
        const retried = yield* lifecycle.retry(created.id)
        expect(retried.waitingForCiRepair).toBe(true)
        expect(retried.holdsWorkerSlot).toBe(false)
        expect(retried.waitingSince).toBeNull()
        expect(retried.state).toBe("create_worktree")
        expect(retried.stepRuns.some((run) => run.status === "queued")).toBe(
          false,
        )
        expect(
          Option.isNone(yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)),
        ).toBe(true)
        expect(createCalls).toBe(1)
      }),
    )
  })

  it("holds Start of ordinary remote work after Pause", () => {
    const started = Effect.runSync(Deferred.make<void>())
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      createWorktree: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.as({
            worktreePath: "/tmp/worktrees/acme-widgets-42",
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
          issue.issueNumber,
        )
        const fiber = yield* Effect.forkChild(
          lifecycle.runStep(created.stepRuns[0]!.id),
        )
        yield* Deferred.await(started)
        yield* lifecycle.pause(created.id)
        yield* Fiber.join(fiber)

        yield* closeCiGate(repository.id)
        const resumed = yield* lifecycle.start(created.id)
        expect(resumed.paused).toBe(false)
        expect(resumed.waitingForCiRepair).toBe(true)
        expect(resumed.holdsWorkerSlot).toBe(false)
        expect(resumed.waitingSince).toBeNull()
        expect(resumed.stepRuns.some((run) => run.status === "queued")).toBe(
          false,
        )
        expect(
          Option.isNone(yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)),
        ).toBe(true)
      }),
    )
  })

  it("lets Implement Locally finish and pause, then holds remote continuation", () =>
    runWithSteps(
      successfulSteps,
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const queue = yield* QueueService
        const { repository, issue } = yield* seedActionableIssue
        yield* closeCiGate(repository.id)

        const created = yield* lifecycle.implementLocally(
          repository.id,
          issue.issueNumber,
        )
        expect(created.waitingForCiRepair).toBe(false)
        expect(created.holdsWorkerSlot).toBe(true)
        expect(created.pauseBeforeStep).toBe("commit")
        expect(created.stepRuns).toHaveLength(1)

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
            expect(result.workItem.waitingForCiRepair).toBe(false)
            if (expectedNext === "commit") {
              expect(result.workItem.paused).toBe(true)
              expect(result.workItem.holdsWorkerSlot).toBe(false)
            }
          }
        }

        const started = yield* lifecycle.start(created.id)
        expect(started.state).toBe("commit")
        expect(started.paused).toBe(false)
        expect(started.waitingForCiRepair).toBe(true)
        expect(started.holdsWorkerSlot).toBe(false)
        expect(started.waitingSince).toBeNull()
        expect(
          started.stepRuns.some(
            (run) => run.step === "commit" && run.status === "queued",
          ),
        ).toBe(false)
        expect(
          Option.isNone(yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)),
        ).toBe(true)
      }),
    ))

  it("does not start a paused held Work Item when the gate reopens", () =>
    runWithSteps(
      successfulSteps,
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const { repository, issue } = yield* seedActionableIssue
        yield* closeCiGate(repository.id)
        const created = yield* lifecycle.implementNow(
          repository.id,
          issue.issueNumber,
        )
        const paused = yield* lifecycle.pause(created.id)
        expect(paused.paused).toBe(true)
        expect(paused.waitingForCiRepair).toBe(true)

        yield* openCiGate(repository.id)
        expect(yield* lifecycle.releaseWaitingForCiRepair(repository.id)).toBe(
          1,
        )
        const afterWake = yield* lifecycle.getWorkItem(created.id)
        expect(afterWake.paused).toBe(true)
        expect(afterWake.waitingForCiRepair).toBe(false)
        expect(afterWake.holdsWorkerSlot).toBe(false)
        expect(afterWake.stepRuns).toHaveLength(0)
      }),
    ))

  it("rejoins ordinary FIFO Worker Slot admission without priority", () =>
    runWithSteps(
      successfulSteps,
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const { repository, issue } = yield* seedActionableIssue
        yield* setMaxWorkItems(1)
        const occupying = yield* lifecycle.implementNow(
          repository.id,
          issue.issueNumber,
        )
        expect(occupying.holdsWorkerSlot).toBe(true)

        const waiterIssue = yield* seedSiblingIssue(repository.id, 43)
        const waiter = yield* lifecycle.implementNow(
          repository.id,
          waiterIssue.issueNumber,
        )
        expect(waiter.holdsWorkerSlot).toBe(false)
        expect(waiter.waitingSince).not.toBeNull()

        yield* closeCiGate(repository.id)
        const heldIssue = yield* seedSiblingIssue(repository.id, 44)
        const held = yield* lifecycle.implementNow(
          repository.id,
          heldIssue.issueNumber,
        )
        expectPreAdmissionHold(held)

        yield* setMaxWorkItems(2)
        yield* openCiGate(repository.id)
        expect(yield* lifecycle.releaseWaitingForCiRepair(repository.id)).toBe(
          1,
        )

        const admittedWaiter = yield* lifecycle.getWorkItem(waiter.id)
        const recovered = yield* lifecycle.getWorkItem(held.id)
        expect(admittedWaiter.holdsWorkerSlot).toBe(true)
        expect(admittedWaiter.waitingSince).toBeNull()
        expect(admittedWaiter.waitingForCiRepair).toBe(false)
        expect(recovered.waitingForCiRepair).toBe(false)
        expect(recovered.holdsWorkerSlot).toBe(false)
        expect(recovered.waitingSince).not.toBeNull()
        expect(recovered.stepRuns).toHaveLength(0)
      }),
    ))

  it("converts Worker Slot waiters to Waiting for CI Repair without hanging when a slot is free", () =>
    runWithSteps(
      successfulSteps,
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const { repository, issue } = yield* seedActionableIssue
        yield* setMaxWorkItems(1)
        const occupying = yield* lifecycle.implementNow(
          repository.id,
          issue.issueNumber,
        )
        expect(occupying.holdsWorkerSlot).toBe(true)

        const waiterIssue = yield* seedSiblingIssue(repository.id, 43)
        const waiter = yield* lifecycle.implementNow(
          repository.id,
          waiterIssue.issueNumber,
        )
        expect(waiter.waitingSince).not.toBeNull()

        yield* closeCiGate(repository.id)
        yield* setMaxWorkItems(2)
        expect(yield* lifecycle.admitWaitingWorkItems).toBe(0)

        const heldWaiter = yield* lifecycle.getWorkItem(waiter.id)
        expect(heldWaiter.waitingForCiRepair).toBe(true)
        expect(heldWaiter.holdsWorkerSlot).toBe(false)
        expect(heldWaiter.waitingSince).toBeNull()
        expect(heldWaiter.stepRuns).toHaveLength(0)
        const stillOccupying = yield* lifecycle.getWorkItem(occupying.id)
        expect(stillOccupying.holdsWorkerSlot).toBe(true)
        expect(stillOccupying.waitingForCiRepair).toBe(false)
      }),
    ))

  it("admits an Open-gate waiter after converting Closed-gate waiters in the same pass", () =>
    runWithSteps(
      successfulSteps,
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const db = yield* DbService
        yield* seedHarnessBuildModel
        yield* setMaxWorkItems(1)
        const closedRepo = yield* db.addRepository({
          ...sampleRepository,
          localPath: "/repos/acme/closed.git",
          projectPath: "acme/closed",
        })
        const openRepo = yield* db.addRepository({
          ...sampleRepository,
          localPath: "/repos/acme/open.git",
          projectPath: "acme/open",
        })
        yield* db.storeIssue({
          repositoryId: closedRepo.id,
          issueNumber: 42,
          ...sampleIssueFields,
          url: "https://github.com/acme/closed/issues/42",
        })
        yield* db.storeIssue({
          repositoryId: closedRepo.id,
          issueNumber: 43,
          ...sampleIssueFields,
          url: "https://github.com/acme/closed/issues/43",
        })
        yield* db.storeIssue({
          repositoryId: openRepo.id,
          issueNumber: 42,
          ...sampleIssueFields,
          url: "https://github.com/acme/open/issues/42",
        })

        const occupying = yield* lifecycle.implementNow(closedRepo.id, 42)
        expect(occupying.holdsWorkerSlot).toBe(true)
        const closedWaiter = yield* lifecycle.implementNow(closedRepo.id, 43)
        expect(closedWaiter.waitingSince).not.toBeNull()
        const openWaiter = yield* lifecycle.implementNow(openRepo.id, 42)
        expect(openWaiter.waitingSince).not.toBeNull()

        yield* closeCiGate(closedRepo.id)
        yield* setMaxWorkItems(2)
        expect(yield* lifecycle.admitWaitingWorkItems).toBe(1)

        const heldClosed = yield* lifecycle.getWorkItem(closedWaiter.id)
        expect(heldClosed.waitingForCiRepair).toBe(true)
        expect(heldClosed.holdsWorkerSlot).toBe(false)
        const admittedOpen = yield* lifecycle.getWorkItem(openWaiter.id)
        expect(admittedOpen.waitingForCiRepair).toBe(false)
        expect(admittedOpen.holdsWorkerSlot).toBe(true)
        expect(admittedOpen.waitingSince).toBeNull()
      }),
    ))

  it("abandons a Needs Human Work Item while the gate is Closed", () =>
    runWithSteps(
      successfulSteps,
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const sql = yield* SqlClient.SqlClient
        const { repository, issue } = yield* seedActionableIssue
        const created = yield* lifecycle.implementNow(
          repository.id,
          issue.issueNumber,
        )
        yield* sql.unsafe(
          `UPDATE work_item
           SET state = 'needs_human',
               pull_request_number = 88,
               failure_code = 'needs_human',
               failure_message = 'Human merge required',
               holds_worker_slot = 0,
               waiting_since = NULL
           WHERE id = ?`,
          [created.id],
        )
        yield* closeCiGate(repository.id)

        const abandoned = yield* lifecycle.abandon(created.id)
        expect(abandoned.state).toBe("abandoned")
        expect(abandoned.waitingForCiRepair).toBe(false)
        expect(abandoned.holdsWorkerSlot).toBe(false)
      }),
    ))

  it("admits recovered holds in creation order under the live Worker Slot cap", () =>
    runWithSteps(
      successfulSteps,
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const { repository, issue } = yield* seedActionableIssue
        yield* closeCiGate(repository.id)
        const first = yield* lifecycle.implementNow(
          repository.id,
          issue.issueNumber,
        )
        const secondIssue = yield* seedSiblingIssue(repository.id, 43)
        const second = yield* lifecycle.implementNow(
          repository.id,
          secondIssue.issueNumber,
        )
        expectPreAdmissionHold(first)
        expectPreAdmissionHold(second)

        yield* setMaxWorkItems(1)
        yield* openCiGate(repository.id)
        expect(yield* lifecycle.releaseWaitingForCiRepair(repository.id)).toBe(
          2,
        )

        const recoveredFirst = yield* lifecycle.getWorkItem(first.id)
        const recoveredSecond = yield* lifecycle.getWorkItem(second.id)
        expect(recoveredFirst.holdsWorkerSlot).toBe(true)
        expect(recoveredFirst.waitingForCiRepair).toBe(false)
        expect(recoveredFirst.stepRuns).toHaveLength(1)
        expect(recoveredSecond.holdsWorkerSlot).toBe(false)
        expect(recoveredSecond.waitingForCiRepair).toBe(false)
        expect(recoveredSecond.waitingSince).not.toBeNull()
        expect(recoveredSecond.stepRuns).toHaveLength(0)
      }),
    ))

  it("preserves held intent, profile, and Merge Policy across restart", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() =>
        mkdtemp(join(tmpdir(), "ci-gate-admission-hold-")),
      )
      const filename = join(dir, "harness.sqlite")
      try {
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            const lifecycle = yield* WorkItemLifecycle
            const { repository, issue } = yield* seedActionableIssue
            yield* closeCiGate(repository.id)
            const created = yield* lifecycle.implementWith(
              repository.id,
              issue.issueNumber,
              implementWithProfile,
              { mergePolicy: "classify" },
            )
            const workItem = created[0]
            if (workItem === undefined) {
              return yield* Effect.die("expected held Implement With")
            }
            expectPreAdmissionHold(workItem)
            return {
              workItemId: workItem.id,
              repositoryId: repository.id,
            }
          }).pipe(Effect.provide(makeTestLayer(successfulSteps, filename))),
        )

        const second = yield* Effect.scoped(
          Effect.gen(function* () {
            const lifecycle = yield* WorkItemLifecycle
            const reloaded = yield* lifecycle.getWorkItem(first.workItemId)
            expectPreAdmissionHold(reloaded)
            expect(reloaded.executionProfile).toEqual({
              agentBackend: "opencode",
              build: { model: "build-model", thinkingLevel: "high" },
              review: { kind: "same_as_build" },
            })
            expect(reloaded.mergeMode).toBe("ordinary")
            expect(reloaded.autoMergeOverride).toBe(true)

            yield* openCiGate(first.repositoryId)
            expect(
              yield* lifecycle.releaseWaitingForCiRepair(first.repositoryId),
            ).toBe(1)
            const woken = yield* lifecycle.getWorkItem(first.workItemId)
            expect(woken.waitingForCiRepair).toBe(false)
            expect(woken.holdsWorkerSlot).toBe(true)
            expect(woken.executionProfile).toEqual(reloaded.executionProfile)
            expect(woken.autoMergeOverride).toBe(true)
            return woken.state
          }).pipe(Effect.provide(makeTestLayer(successfulSteps, filename))),
        )
        expect(second).toBe("create_worktree")
      } finally {
        yield* Effect.promise(() => rm(dir, { recursive: true, force: true }))
      }
    }).pipe(Effect.runPromise))

  it("does not hold ordinary Implement Now when the cached gate is Open", () =>
    runWithSteps(
      successfulSteps,
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const { repository, issue } = yield* seedActionableIssue
        const created = yield* lifecycle.implementNow(
          repository.id,
          issue.issueNumber,
        )
        expect(created.waitingForCiRepair).toBe(false)
        expect(created.holdsWorkerSlot).toBe(true)
        expect(created.stepRuns).toHaveLength(1)
      }),
    ))
})
