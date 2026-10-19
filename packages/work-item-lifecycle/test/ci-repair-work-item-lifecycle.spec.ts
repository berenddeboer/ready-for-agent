import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
  LifecycleSteps,
  type LifecycleStepsShape,
  WorkItemLifecycle,
  WorkItemLifecycleLive,
  stubActiveAgentBackendLayer,
  stubAzureDevOpsServiceLayer,
  stubGitHubServiceLayer,
  stubGitLabServiceLayer,
  stubLinearServiceLayer,
} from "../src/index.js"
import {
  recordCiRepairMergeFloor,
  recordCiRepairNoChangeBaseline,
} from "../src/lib/ci-repair-baseline.js"
import { describe, expect, it, setDefaultTimeout } from "bun:test"

setDefaultTimeout(30_000)

const idleSteps: LifecycleStepsShape = {
  createWorktree: () => Effect.die("unused"),
  installDependencies: () => Effect.die("unused"),
  implement: () => Effect.die("unused"),
  assessChanges: () => Effect.die("unused"),
  preCommit: () => Effect.die("unused"),
  review: () => Effect.die("unused"),
  commit: () => Effect.die("unused"),
  createPr: () => Effect.die("unused"),
  watchPrStatusChecks: () => Effect.die("unused"),
  resolvePrMergeConflict: () => Effect.die("unused"),
  investigatePrStatusChecks: () => Effect.die("unused"),
  markPrReadyForReview: () => Effect.die("unused"),
  decidePrMerge: () => Effect.die("unused"),
  mergePr: () => Effect.die("unused"),
  closeIssue: () => Effect.die("unused"),
  localCleanup: () => Effect.die("unused"),
  removeWorktree: () => Effect.die("unused"),
}

const layer = WorkItemLifecycleLive.pipe(
  Layer.provideMerge(
    stubActiveAgentBackendLayer({
      models: [
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
  Layer.provideMerge(stubLinearServiceLayer()),
  Layer.provideMerge(
    Layer.succeed(LifecycleSteps, LifecycleSteps.of(idleSteps)),
  ),
  Layer.provideMerge(DbServiceLive),
  Layer.provideMerge(SqliteQueueServiceLive),
  Layer.provideMerge(DatabaseTest),
)

const run = <A>(
  test: Effect.Effect<A, unknown, Layer.Layer.Success<typeof layer>>,
) => Effect.runPromise(Effect.provide(test, layer))

const sampleRepository = {
  forge: "github" as const,
  forgeHost: "github.com",
  projectPath: "acme/widgets",
  localPath: "/repos/acme/widgets.git",
  isBare: true,
}

const seedRepository = (input: {
  readonly localPath: string
  readonly paused: boolean
  readonly automaticCiRepair: boolean
  readonly closed: boolean
  readonly inProgressOnly?: boolean
  readonly runIdentity?: string
  readonly orderKey?: string
  readonly earlyJobFailure?: boolean
  readonly headSha?: string
}) =>
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
      maxConcurrentWorkItems: config.maxConcurrentWorkItems,
    })
    const repository = yield* db.addRepository({
      ...sampleRepository,
      localPath: input.localPath,
      projectPath: `acme/${input.localPath.split("/").at(-1) ?? "widgets"}`,
    })
    yield* db.updateRepositorySettings({
      repositoryId: repository.id,
      paused: input.paused,
      defaultModel: null,
      defaultThinkingLevel: null,
      reviewModel: null,
      reviewThinkingLevel: null,
      mergePolicy: repository.mergePolicy,
      includeAllIssueAuthors: repository.includeAllIssueAuthors,
      waitForReadyForReviewChecks: repository.waitForReadyForReviewChecks,
      automaticCiRepair: input.automaticCiRepair,
      selectedCiGateDefinitions: [
        {
          identity: "build",
          displayLabel: "Build",
          kind: "workflow",
          diagnosticMetadata: null,
        },
      ],
    })
    const runIdentity = input.runIdentity ?? "10:1"
    const inProgress = input.inProgressOnly === true
    yield* db.commitCiGateSnapshot({
      repositoryId: repository.id,
      defaultBranch: "main",
      lastObservedAt: new Date("2026-10-19T00:00:00.000Z"),
      observations: input.closed
        ? [
            {
              identity: "build",
              lastObservedAt: new Date("2026-10-19T00:00:00.000Z"),
              lastRunIdentity: runIdentity,
              lastRunHtmlUrl: "https://ci.example/10",
              lastHeadSha: input.headSha ?? (inProgress ? null : "abc123"),
              lastHeadRef: "refs/heads/main",
              lastEvent: "push",
              lastRawStatus: inProgress ? "in_progress" : "completed",
              lastRawConclusion: inProgress ? null : "failure",
              lastRunCreatedAt: new Date("2026-10-19T00:00:00.000Z"),
              lastRunUpdatedAt: new Date("2026-10-19T00:00:00.000Z"),
              failureLatched: true,
              latchedRunIdentity: runIdentity,
              latchedRunHtmlUrl: "https://ci.example/10",
              observationError: null,
              observationErrorKind: null,
              lastRunOrderKey: input.orderKey ?? null,
              latchedRunOrderKey: input.orderKey ?? null,
              lastEarlyJobFailure: input.earlyJobFailure === true,
            },
          ]
        : [],
      incidentsToUpsert: [],
    })
    return repository
  })

describe("CI Repair Work Item lifecycle", () => {
  it("starts one CI Repair Work Item from a Closed gate and ignores a second start", () =>
    run(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const sql = yield* SqlClient.SqlClient
        const open = yield* seedRepository({
          localPath: "/repos/acme/open.git",
          paused: true,
          automaticCiRepair: false,
          closed: false,
        })
        const rejected = yield* lifecycle
          .startCiRepair(open.id)
          .pipe(Effect.flip)
        expect(rejected._tag).toBe("CiRepairGateNotClosedError")

        const repository = yield* seedRepository({
          localPath: "/repos/acme/closed.git",
          paused: true,
          automaticCiRepair: false,
          closed: true,
        })
        const db = yield* DbService
        const issue = yield* db.storeIssue({
          repositoryId: repository.id,
          issueNumber: 42,
          title: "Ordinary work",
          body: "body",
          url: "https://github.com/acme/widgets/issues/42",
          state: "OPEN",
          githubCreatedAt: new Date("2026-01-15T12:00:00.000Z"),
          issueAuthor: null,
          parent: null,
          parentPosition: null,
          hasChildren: false,
          blockedBy: [],
        })
        const ordinary = yield* lifecycle.implementNow(
          repository.id,
          issue.nativeId,
        )
        expect(ordinary.origin).toBe("issue")
        expect(ordinary.waitingForCiRepair).toBe(true)

        const started = yield* lifecycle.startCiRepair(repository.id)
        const again = yield* lifecycle.startCiRepair(repository.id)
        expect(again.id).toBe(started.id)
        expect(started.origin).toBe("ci_repair")
        expect(started.issueNumber).toBe(0)
        expect(started.issueSource.nativeId).toBe("ci-repair")
        expect(started.issueSource.tracker).toBe("github")
        expect(started.issueTitle).toBe("Repair CI on main")
        expect(started.ciRepairDefaultBranch).toBe("main")
        expect(started.ciRepairHeadSha).toBe("abc123")
        expect(started.ciRepairFailingRuns).toEqual([
          {
            runIdentity: "10:1",
            htmlUrl: "https://ci.example/10",
            displayLabel: "Build",
            definitionIdentity: "build",
          },
        ])
        expect(started.waitingForCiRepair).toBe(false)
        expect(started.holdsWorkerSlot).toBe(true)
        expect(started.state).toBe("create_worktree")

        const authorizations = (yield* sql.unsafe(
          `SELECT COUNT(*) AS count
           FROM ci_repair_authorization
           WHERE work_item_id = ?`,
          [started.id],
        )) as readonly { readonly count: number }[]
        expect(Number(authorizations[0]?.count ?? 0)).toBe(0)

        const concurrentRepository = yield* seedRepository({
          localPath: "/repos/acme/concurrent.git",
          paused: false,
          automaticCiRepair: false,
          closed: true,
        })
        const raced = yield* Effect.all(
          [
            lifecycle.startCiRepair(concurrentRepository.id),
            lifecycle.startCiRepair(concurrentRepository.id),
          ],
          { concurrency: 2 },
        )
        expect(raced[0].id).toBe(raced[1].id)
        const rows = (yield* sql.unsafe(
          `SELECT COUNT(*) AS count
           FROM work_item
           WHERE repository_id = ? AND origin = 'ci_repair'`,
          [concurrentRepository.id],
        )) as readonly { readonly count: number }[]
        expect(Number(rows[0]?.count ?? 0)).toBe(1)
      }),
    ))

  it("starts automatically only when the setting is on, the repository is not paused, and the latched run is a terminal failure", () =>
    run(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const settingOff = yield* seedRepository({
          localPath: "/repos/acme/auto-off.git",
          paused: false,
          automaticCiRepair: false,
          closed: true,
        })
        expect(
          yield* lifecycle.considerAutomaticCiRepair(settingOff.id),
        ).toBeNull()

        const paused = yield* seedRepository({
          localPath: "/repos/acme/auto-paused.git",
          paused: true,
          automaticCiRepair: true,
          closed: true,
        })
        expect(yield* lifecycle.considerAutomaticCiRepair(paused.id)).toBeNull()

        const inProgress = yield* seedRepository({
          localPath: "/repos/acme/auto-progress.git",
          paused: false,
          automaticCiRepair: true,
          closed: true,
          inProgressOnly: true,
        })
        expect(
          yield* lifecycle.considerAutomaticCiRepair(inProgress.id),
        ).toBeNull()

        const ready = yield* seedRepository({
          localPath: "/repos/acme/auto-ready.git",
          paused: false,
          automaticCiRepair: true,
          closed: true,
        })
        const started = yield* lifecycle.considerAutomaticCiRepair(ready.id)
        expect(started?.origin).toBe("ci_repair")
        expect(started?.issueTitle).toBe("Repair CI on main")
        expect(started?.ciRepairHeadSha).toBe("abc123")
        expect(yield* lifecycle.considerAutomaticCiRepair(ready.id)).toBeNull()
        const manual = yield* lifecycle.startCiRepair(ready.id)
        expect(manual.id).toBe(started?.id)
      }),
    ))

  it("waits behind a running holder, then takes the next Worker Slot ahead of an older ordinary waiter", () =>
    run(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
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
          maxConcurrentWorkItems: 1,
        })
        const repository = yield* seedRepository({
          localPath: "/repos/acme/queue.git",
          paused: false,
          automaticCiRepair: false,
          closed: false,
        })
        const store = (issueNumber: number) =>
          db.storeIssue({
            repositoryId: repository.id,
            issueNumber,
            title: `Issue ${issueNumber}`,
            body: "body",
            url: `https://github.com/acme/widgets/issues/${issueNumber}`,
            state: "OPEN",
            githubCreatedAt: new Date("2026-01-15T12:00:00.000Z"),
            issueAuthor: null,
            parent: null,
            parentPosition: null,
            hasChildren: false,
            blockedBy: [],
          })
        const firstIssue = yield* store(7)
        const holder = yield* lifecycle.implementNow(
          repository.id,
          firstIssue.nativeId,
        )
        expect(holder.holdsWorkerSlot).toBe(true)
        const secondIssue = yield* store(8)
        const waiter = yield* lifecycle.implementNow(
          repository.id,
          secondIssue.nativeId,
        )
        expect(waiter.holdsWorkerSlot).toBe(false)
        expect(waiter.waitingSince).not.toBeNull()

        yield* db.commitCiGateSnapshot({
          repositoryId: repository.id,
          defaultBranch: "main",
          lastObservedAt: new Date("2026-10-19T00:00:00.000Z"),
          observations: [
            {
              identity: "build",
              lastObservedAt: new Date("2026-10-19T00:00:00.000Z"),
              lastRunIdentity: "10:1",
              lastRunHtmlUrl: "https://ci.example/10",
              lastHeadSha: "abc123",
              lastHeadRef: "refs/heads/main",
              lastEvent: "push",
              lastRawStatus: "completed",
              lastRawConclusion: "failure",
              lastRunCreatedAt: new Date("2026-10-19T00:00:00.000Z"),
              lastRunUpdatedAt: new Date("2026-10-19T00:00:00.000Z"),
              failureLatched: true,
              latchedRunIdentity: "10:1",
              latchedRunHtmlUrl: "https://ci.example/10",
              observationError: null,
              observationErrorKind: null,
            },
          ],
          incidentsToUpsert: [],
        })
        const repair = yield* lifecycle.startCiRepair(repository.id)
        expect(repair.holdsWorkerSlot).toBe(false)
        expect(repair.waitingForCiRepair).toBe(false)
        expect(repair.waitingSince).not.toBeNull()
        const holderAfter = yield* lifecycle.getWorkItem(holder.id)
        expect(holderAfter.holdsWorkerSlot).toBe(true)

        yield* db.updateConfig({
          selectedAgentBackend: "opencode",
          defaultModel:
            config.defaultModel ?? "opencode/deepseek-v4-flash-free",
          defaultThinkingLevel: config.defaultThinkingLevel ?? "low",
          reviewModel: config.reviewModel,
          reviewThinkingLevel: config.reviewThinkingLevel,
          maxConcurrentAgentTurns: config.maxConcurrentAgentTurns,
          maxConcurrentWorkItems: 2,
        })
        yield* lifecycle.admitWaitingWorkItems
        const admittedRepair = yield* lifecycle.getWorkItem(repair.id)
        const stillWaiting = yield* lifecycle.getWorkItem(waiter.id)
        expect(admittedRepair.holdsWorkerSlot).toBe(true)
        expect(admittedRepair.waitingSince).toBeNull()
        expect(stillWaiting.holdsWorkerSlot).toBe(false)
        expect(stillWaiting.waitingSince).not.toBeNull()
      }),
    ))

  it("starts a repair from a still-running GitHub run once a job has failed", () =>
    run(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const repository = yield* seedRepository({
          localPath: "/repos/acme/early-job.git",
          paused: false,
          automaticCiRepair: true,
          closed: true,
          inProgressOnly: true,
          earlyJobFailure: true,
          orderKey: "00000000000000000010:000001",
          headSha: "deadbeef",
        })
        const started = yield* lifecycle.considerAutomaticCiRepair(
          repository.id,
        )
        expect(started?.origin).toBe("ci_repair")
        expect(started?.ciRepairHeadSha).toBe("deadbeef")
        const db = yield* DbService
        yield* db.commitCiGateSnapshot({
          repositoryId: repository.id,
          defaultBranch: "main",
          lastObservedAt: new Date("2026-10-19T01:00:00.000Z"),
          observations: [
            {
              identity: "build",
              lastObservedAt: new Date("2026-10-19T01:00:00.000Z"),
              lastRunIdentity: "99:1",
              lastRunHtmlUrl: "https://ci.example/99",
              lastHeadSha: "later",
              lastHeadRef: "refs/heads/main",
              lastEvent: "push",
              lastRawStatus: "completed",
              lastRawConclusion: "failure",
              lastRunCreatedAt: new Date("2026-10-19T01:00:00.000Z"),
              lastRunUpdatedAt: new Date("2026-10-19T01:00:00.000Z"),
              failureLatched: true,
              latchedRunIdentity: "99:1",
              latchedRunHtmlUrl: "https://ci.example/99",
              observationError: null,
              observationErrorKind: null,
              lastRunOrderKey: "00000000000000000099:000001",
              latchedRunOrderKey: "00000000000000000099:000001",
              lastEarlyJobFailure: false,
            },
          ],
          incidentsToUpsert: [],
        })
        const unchanged = yield* lifecycle.getWorkItem(started?.id ?? "")
        expect(
          unchanged.ciRepairFailingRuns.map((run) => run.runIdentity),
        ).toEqual(["10:1"])
        expect(
          yield* lifecycle.considerAutomaticCiRepair(repository.id),
        ).toBeNull()
      }),
    ))

  it("does not loop on already-fixed, and a newer rerun starts one repair", () =>
    run(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const sql = yield* SqlClient.SqlClient
        const db = yield* DbService
        const repository = yield* seedRepository({
          localPath: "/repos/acme/already-fixed.git",
          paused: false,
          automaticCiRepair: true,
          closed: true,
          orderKey: "00000000000000000010:000001",
        })
        const started = yield* lifecycle.considerAutomaticCiRepair(
          repository.id,
        )
        expect(started).not.toBeNull()
        yield* recordCiRepairNoChangeBaseline(sql, repository.id)
        yield* sql.unsafe(
          `UPDATE work_item SET state = 'complete' WHERE id = ?`,
          [started?.id],
        )
        expect(
          yield* lifecycle.considerAutomaticCiRepair(repository.id),
        ).toBeNull()

        yield* db.commitCiGateSnapshot({
          repositoryId: repository.id,
          defaultBranch: "main",
          lastObservedAt: new Date("2026-10-19T01:00:00.000Z"),
          observations: [
            {
              identity: "build",
              lastObservedAt: new Date("2026-10-19T01:00:00.000Z"),
              lastRunIdentity: "10:2",
              lastRunHtmlUrl: "https://ci.example/10",
              lastHeadSha: "abc123",
              lastHeadRef: "refs/heads/main",
              lastEvent: "push",
              lastRawStatus: "completed",
              lastRawConclusion: "failure",
              lastRunCreatedAt: new Date("2026-10-19T01:00:00.000Z"),
              lastRunUpdatedAt: new Date("2026-10-19T01:00:00.000Z"),
              failureLatched: true,
              latchedRunIdentity: "10:2",
              latchedRunHtmlUrl: "https://ci.example/10",
              observationError: null,
              observationErrorKind: null,
              lastRunOrderKey: "00000000000000000010:000002",
              latchedRunOrderKey: "00000000000000000010:000002",
              lastEarlyJobFailure: false,
            },
          ],
          incidentsToUpsert: [],
        })
        const rerun = yield* lifecycle.considerAutomaticCiRepair(repository.id)
        expect(rerun?.origin).toBe("ci_repair")
        expect(rerun?.id).not.toBe(started?.id)
        expect(
          yield* lifecycle.considerAutomaticCiRepair(repository.id),
        ).toBeNull()
      }),
    ))

  it("starts exactly one repair when the merge-commit run fails, and keeps that baseline across a fresh read", () =>
    run(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const sql = yield* SqlClient.SqlClient
        const db = yield* DbService
        const repository = yield* seedRepository({
          localPath: "/repos/acme/merge-baseline.git",
          paused: false,
          automaticCiRepair: true,
          closed: true,
          orderKey: "00000000000000000010:000001",
        })
        const started = yield* lifecycle.considerAutomaticCiRepair(
          repository.id,
        )
        expect(started).not.toBeNull()
        yield* recordCiRepairMergeFloor(
          sql,
          repository.id,
          started?.ciRepairFailingRuns ?? [],
        )
        yield* sql.unsafe(
          `UPDATE work_item SET state = 'complete' WHERE id = ?`,
          [started?.id],
        )
        expect(
          yield* lifecycle.considerAutomaticCiRepair(repository.id),
        ).toBeNull()

        yield* db.commitCiGateSnapshot({
          repositoryId: repository.id,
          defaultBranch: "main",
          lastObservedAt: new Date("2026-10-19T02:00:00.000Z"),
          observations: [
            {
              identity: "build",
              lastObservedAt: new Date("2026-10-19T02:00:00.000Z"),
              lastRunIdentity: "11:1",
              lastRunHtmlUrl: "https://ci.example/11",
              lastHeadSha: "mergecommit",
              lastHeadRef: "refs/heads/main",
              lastEvent: "push",
              lastRawStatus: "in_progress",
              lastRawConclusion: null,
              lastRunCreatedAt: new Date("2026-10-19T02:00:00.000Z"),
              lastRunUpdatedAt: new Date("2026-10-19T02:00:00.000Z"),
              failureLatched: true,
              latchedRunIdentity: "11:1",
              latchedRunHtmlUrl: "https://ci.example/11",
              observationError: null,
              observationErrorKind: null,
              lastRunOrderKey: "00000000000000000011:000001",
              latchedRunOrderKey: "00000000000000000011:000001",
              lastEarlyJobFailure: true,
            },
          ],
          incidentsToUpsert: [],
        })
        const again = yield* lifecycle.considerAutomaticCiRepair(repository.id)
        expect(again?.origin).toBe("ci_repair")
        expect(again?.id).not.toBe(started?.id)
        expect(
          yield* lifecycle.considerAutomaticCiRepair(repository.id),
        ).toBeNull()
        const stored = (yield* sql.unsafe(
          `SELECT floor_order_key AS floorOrderKey, inclusive AS inclusive
           FROM ci_repair_baseline
           WHERE repository_id = ?`,
          [repository.id],
        )) as readonly {
          readonly floorOrderKey: string | null
          readonly inclusive: number
        }[]
        expect(stored[0]?.floorOrderKey).toBe("00000000000000000010:000001")
        expect(Number(stored[0]?.inclusive)).toBe(0)
      }),
    ))

  it("still starts a repair for the merge-commit run after a later run was observed first", () =>
    run(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const sql = yield* SqlClient.SqlClient
        const db = yield* DbService
        const repository = yield* seedRepository({
          localPath: "/repos/acme/merge-later-first.git",
          paused: false,
          automaticCiRepair: true,
          closed: true,
          orderKey: "00000000000000000010:000001",
        })
        const started = yield* lifecycle.considerAutomaticCiRepair(
          repository.id,
        )
        expect(started).not.toBeNull()
        yield* recordCiRepairMergeFloor(
          sql,
          repository.id,
          started?.ciRepairFailingRuns ?? [],
        )
        yield* sql.unsafe(
          `UPDATE work_item SET state = 'complete' WHERE id = ?`,
          [started?.id],
        )
        yield* db.commitCiGateSnapshot({
          repositoryId: repository.id,
          defaultBranch: "main",
          lastObservedAt: new Date("2026-10-19T02:00:00.000Z"),
          observations: [
            {
              identity: "build",
              lastObservedAt: new Date("2026-10-19T02:00:00.000Z"),
              lastRunIdentity: "12:1",
              lastRunHtmlUrl: "https://ci.example/12",
              lastHeadSha: "schedule",
              lastHeadRef: "refs/heads/main",
              lastEvent: "schedule",
              lastRawStatus: "in_progress",
              lastRawConclusion: null,
              lastRunCreatedAt: new Date("2026-10-19T02:00:00.000Z"),
              lastRunUpdatedAt: new Date("2026-10-19T02:00:00.000Z"),
              failureLatched: true,
              latchedRunIdentity: "10:1",
              latchedRunHtmlUrl: "https://ci.example/10",
              observationError: null,
              observationErrorKind: null,
              lastRunOrderKey: "00000000000000000012:000001",
              latchedRunOrderKey: "00000000000000000010:000001",
              lastEarlyJobFailure: false,
            },
          ],
          incidentsToUpsert: [],
        })
        expect(
          yield* lifecycle.considerAutomaticCiRepair(repository.id),
        ).toBeNull()

        yield* db.commitCiGateSnapshot({
          repositoryId: repository.id,
          defaultBranch: "main",
          lastObservedAt: new Date("2026-10-19T02:05:00.000Z"),
          observations: [
            {
              identity: "build",
              lastObservedAt: new Date("2026-10-19T02:05:00.000Z"),
              lastRunIdentity: "12:1",
              lastRunHtmlUrl: "https://ci.example/12",
              lastHeadSha: "schedule",
              lastHeadRef: "refs/heads/main",
              lastEvent: "schedule",
              lastRawStatus: "in_progress",
              lastRawConclusion: null,
              lastRunCreatedAt: new Date("2026-10-19T02:05:00.000Z"),
              lastRunUpdatedAt: new Date("2026-10-19T02:05:00.000Z"),
              failureLatched: true,
              latchedRunIdentity: "11:1",
              latchedRunHtmlUrl: "https://ci.example/11",
              observationError: null,
              observationErrorKind: null,
              lastRunOrderKey: "00000000000000000012:000001",
              latchedRunOrderKey: "00000000000000000011:000001",
              lastEarlyJobFailure: false,
            },
          ],
          incidentsToUpsert: [],
        })
        const repair = yield* lifecycle.considerAutomaticCiRepair(repository.id)
        expect(repair?.origin).toBe("ci_repair")
        expect(repair?.ciRepairFailingRuns[0]?.runIdentity).toBe("11:1")
      }),
    ))

  it("records a merge floor when a human merge moves the repair to cleanup", () =>
    run(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const sql = yield* SqlClient.SqlClient
        const repository = yield* seedRepository({
          localPath: "/repos/acme/human-merge.git",
          paused: false,
          automaticCiRepair: true,
          closed: true,
          orderKey: "00000000000000000010:000001",
        })
        const started = yield* lifecycle.considerAutomaticCiRepair(
          repository.id,
        )
        expect(started).not.toBeNull()
        if (started === null) {
          return
        }
        yield* sql.unsafe(
          `UPDATE work_item SET pull_request_number = 7 WHERE id = ?`,
          [started.id],
        )
        const resumed = yield* lifecycle.continueAfterHumanPrOutcome(
          started.id,
          "merged",
        )
        expect(resumed.state).toBe("local_cleanup")
        const stored = (yield* sql.unsafe(
          `SELECT floor_order_key AS floorOrderKey
           FROM ci_repair_baseline
           WHERE repository_id = ?`,
          [repository.id],
        )) as readonly { readonly floorOrderKey: string | null }[]
        expect(stored[0]?.floorOrderKey).toBe("00000000000000000010:000001")
        yield* sql.unsafe(
          `UPDATE work_item SET state = 'complete' WHERE id = ?`,
          [started.id],
        )
        expect(
          yield* lifecycle.considerAutomaticCiRepair(repository.id),
        ).toBeNull()
      }),
    ))

  it("keeps the pre-merge floor when the merge-commit run is already the newest observation", () =>
    run(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const sql = yield* SqlClient.SqlClient
        const db = yield* DbService
        const repository = yield* seedRepository({
          localPath: "/repos/acme/late-merge-notice.git",
          paused: false,
          automaticCiRepair: true,
          closed: true,
          orderKey: "00000000000000000010:000001",
        })
        const started = yield* lifecycle.considerAutomaticCiRepair(
          repository.id,
        )
        expect(started).not.toBeNull()
        if (started === null) {
          return
        }
        yield* db.commitCiGateSnapshot({
          repositoryId: repository.id,
          defaultBranch: "main",
          lastObservedAt: new Date("2026-10-19T04:00:00.000Z"),
          observations: [
            {
              identity: "build",
              lastObservedAt: new Date("2026-10-19T04:00:00.000Z"),
              lastRunIdentity: "11:1",
              lastRunHtmlUrl: "https://ci.example/11",
              lastHeadSha: "mergecommit",
              lastHeadRef: "refs/heads/main",
              lastEvent: "push",
              lastRawStatus: "completed",
              lastRawConclusion: "failure",
              lastRunCreatedAt: new Date("2026-10-19T04:00:00.000Z"),
              lastRunUpdatedAt: new Date("2026-10-19T04:00:00.000Z"),
              failureLatched: true,
              latchedRunIdentity: "11:1",
              latchedRunHtmlUrl: "https://ci.example/11",
              observationError: null,
              observationErrorKind: null,
              lastRunOrderKey: "00000000000000000011:000001",
              latchedRunOrderKey: "00000000000000000011:000001",
              lastEarlyJobFailure: false,
            },
          ],
          incidentsToUpsert: [],
        })
        yield* sql.unsafe(
          `UPDATE work_item SET pull_request_number = 8 WHERE id = ?`,
          [started.id],
        )
        yield* lifecycle.continueAfterHumanPrOutcome(started.id, "merged")
        const stored = (yield* sql.unsafe(
          `SELECT floor_order_key AS floorOrderKey
           FROM ci_repair_baseline
           WHERE repository_id = ?`,
          [repository.id],
        )) as readonly { readonly floorOrderKey: string | null }[]
        expect(stored[0]?.floorOrderKey).toBe("00000000000000000010:000001")
        yield* sql.unsafe(
          `UPDATE work_item SET state = 'complete' WHERE id = ?`,
          [started.id],
        )
        const repair = yield* lifecycle.considerAutomaticCiRepair(repository.id)
        expect(repair?.origin).toBe("ci_repair")
        expect(repair?.ciRepairFailingRuns[0]?.runIdentity).toBe("11:1")
        expect(
          yield* lifecycle.considerAutomaticCiRepair(repository.id),
        ).toBeNull()
      }),
    ))

  it("does not restart an abandoned repair for the same failure, and does for a newer one", () =>
    run(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const db = yield* DbService
        const repository = yield* seedRepository({
          localPath: "/repos/acme/abandoned.git",
          paused: false,
          automaticCiRepair: true,
          closed: true,
          orderKey: "00000000000000000010:000001",
        })
        const started = yield* lifecycle.considerAutomaticCiRepair(
          repository.id,
        )
        expect(started).not.toBeNull()
        if (started === null) {
          return
        }
        yield* lifecycle.abandon(started.id)
        expect(
          yield* lifecycle.considerAutomaticCiRepair(repository.id),
        ).toBeNull()
        const manual = yield* lifecycle.startCiRepair(repository.id)
        expect(manual.id).not.toBe(started.id)
        yield* lifecycle.abandon(manual.id)

        yield* db.commitCiGateSnapshot({
          repositoryId: repository.id,
          defaultBranch: "main",
          lastObservedAt: new Date("2026-10-19T03:00:00.000Z"),
          observations: [
            {
              identity: "build",
              lastObservedAt: new Date("2026-10-19T03:00:00.000Z"),
              lastRunIdentity: "12:1",
              lastRunHtmlUrl: "https://ci.example/12",
              lastHeadSha: "newer",
              lastHeadRef: "refs/heads/main",
              lastEvent: "push",
              lastRawStatus: "completed",
              lastRawConclusion: "failure",
              lastRunCreatedAt: new Date("2026-10-19T03:00:00.000Z"),
              lastRunUpdatedAt: new Date("2026-10-19T03:00:00.000Z"),
              failureLatched: true,
              latchedRunIdentity: "12:1",
              latchedRunHtmlUrl: "https://ci.example/12",
              observationError: null,
              observationErrorKind: null,
              lastRunOrderKey: "00000000000000000012:000001",
              latchedRunOrderKey: "00000000000000000012:000001",
              lastEarlyJobFailure: false,
            },
          ],
          incidentsToUpsert: [],
        })
        const newer = yield* lifecycle.considerAutomaticCiRepair(repository.id)
        expect(newer?.origin).toBe("ci_repair")
        expect(newer?.id).not.toBe(started.id)
      }),
    ))
})
