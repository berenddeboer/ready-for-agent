import { Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import { QueueService } from "@ready-for-agent/queue-service"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
  LifecycleSteps,
  type LifecycleStepsShape,
  ResumeNotEligibleError,
  WORK_ITEM_LIFECYCLE_QUEUE,
  WorkItemLifecycle,
  WorkItemLifecycleLive,
  stubActiveAgentBackendLayer,
  stubAzureDevOpsServiceLayer,
  stubGitHubServiceLayer,
  stubGitLabServiceLayer,
  stubLinearServiceLayer,
} from "../src/index.js"
import { describe, expect, it, setDefaultTimeout } from "bun:test"

setDefaultTimeout(30_000)

const HANDOFF_REASON =
  "Merge would trigger production deployment despite the deployment freeze"

describe("Resume a Decide PR Merge handoff", () => {
  const calls = {
    implement: 0,
    createPr: 0,
    decide: 0,
    merge: 0,
  }
  let decideMode: "needs_human" | "clanker_merge" = "needs_human"
  let lastDecideContext: {
    readonly sessionId: string | null
    readonly recordedReason: string | null
    readonly resumed: boolean
  } | null = null

  const steps: LifecycleStepsShape = {
    createWorktree: () =>
      Effect.succeed({
        worktreePath: "/tmp/worktrees/acme-widgets-42",
        startingCommitOid: "abc123",
      }),
    installDependencies: () => Effect.void,
    implement: () => {
      calls.implement += 1
      return Effect.succeed("ses_merge_assessment")
    },
    assessChanges: () => Effect.succeed({ _tag: "changes" }),
    preCommit: () => Effect.void,
    review: () => Effect.succeed({ _tag: "clean" as const }),
    commit: () =>
      Effect.succeed({
        _tag: "committed" as const,
        completion: "native" as const,
        publicationTitle: "feat: test",
        publicationBody: "Why",
      }),
    createPr: () => {
      calls.createPr += 1
      return Effect.succeed({
        pullRequestNumber: 952,
        completion: "native" as const,
        publicationTitle: "feat: test",
        publicationBody: "Why",
      })
    },
    watchPrStatusChecks: () =>
      Effect.succeed({
        _tag: "succeeded" as const,
        createdAt: new Date(0),
        headSha: "settled-head",
        headPushedAt: new Date(0),
        isDraft: false,
      }),
    resolvePrMergeConflict: () => Effect.die("resolve must not run"),
    investigatePrStatusChecks: () => Effect.die("investigate must not run"),
    markPrReadyForReview: () => Effect.die("mark ready must not run"),
    decidePrMerge: (context) => {
      calls.decide += 1
      lastDecideContext = {
        sessionId: context.sessionId,
        recordedReason: context.mergeAssessmentResume?.recordedReason ?? null,
        resumed: context.mergeAssessmentResume !== undefined,
      }
      if (decideMode === "clanker_merge") {
        return Effect.succeed({ _tag: "clanker_merge" as const })
      }
      return Effect.succeed({
        _tag: "needs_human" as const,
        reason: "deployment freeze still applies",
      })
    },
    mergePr: () => {
      calls.merge += 1
      return Effect.succeed({
        _tag: "revalidation" as const,
        reason: "head_changed" as const,
        message: "head changed after the fresh merge decision",
      })
    },
    closeIssue: () => Effect.die("close issue must not run"),
    localCleanup: () => Effect.void,
    removeWorktree: () => Effect.void,
  }

  const layer = WorkItemLifecycleLive.pipe(
    Layer.provideMerge(stubActiveAgentBackendLayer()),
    Layer.provideMerge(stubGitHubServiceLayer()),
    Layer.provideMerge(stubGitLabServiceLayer()),
    Layer.provideMerge(stubAzureDevOpsServiceLayer()),
    Layer.provideMerge(stubLinearServiceLayer()),
    Layer.provideMerge(Layer.succeed(LifecycleSteps, LifecycleSteps.of(steps))),
    Layer.provideMerge(DbServiceLive),
    Layer.provideMerge(SqliteQueueServiceLive),
    Layer.provideMerge(DatabaseTest),
  )

  const claimAndRunPending = Effect.gen(function* () {
    const lifecycle = yield* WorkItemLifecycle
    const queue = yield* QueueService
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
    const claimed = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
    expect(Option.isSome(claimed)).toBe(true)
    if (Option.isNone(claimed)) {
      return yield* Effect.die("expected a queued lifecycle job")
    }
    return yield* lifecycle.runStep(
      (claimed.value.payload as { stepRunId: string }).stepRunId,
    )
  })

  const seedIssue = (issueNumber: number) =>
    Effect.gen(function* () {
      const db = yield* DbService
      const config = yield* db.getConfig
      yield* db.updateConfig({
        selectedAgentBackend: "opencode",
        defaultModel: config.defaultModel ?? "opencode/test",
        defaultThinkingLevel: config.defaultThinkingLevel ?? "low",
        reviewModel: config.reviewModel,
        reviewThinkingLevel: config.reviewThinkingLevel,
        maxConcurrentAgentTurns: config.maxConcurrentAgentTurns,
        maxConcurrentWorkItems: config.maxConcurrentWorkItems,
      })
      const repository = yield* db.addRepository({
        forge: "github",
        forgeHost: "github.com",
        projectPath: `acme/widgets-${String(issueNumber)}`,
        localPath: `/repos/widgets-${String(issueNumber)}.git`,
        isBare: true,
      })
      const issue = yield* db.storeIssue({
        repositoryId: repository.id,
        issueNumber,
        title: "Lift the freeze",
        body: "Deployment freeze",
        url: `https://github.com/acme/widgets/issues/${String(issueNumber)}`,
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

  it("resumes a persisted null-reason handoff into a fresh merge assessment", async () => {
    calls.implement = 0
    calls.createPr = 0
    calls.decide = 0
    calls.merge = 0
    decideMode = "needs_human"
    lastDecideContext = null

    await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const sql = yield* SqlClient.SqlClient
        const { repository, issue } = yield* seedIssue(948)
        const created = yield* lifecycle.implementNow(
          repository.id,
          issue.nativeId,
        )
        yield* claimAndRunPending
        yield* claimAndRunPending
        const afterImplement = yield* claimAndRunPending
        expect(afterImplement._tag).toBe("processed")
        if (afterImplement._tag !== "processed") {
          return
        }
        expect(afterImplement.workItem.sessionId).toBe("ses_merge_assessment")
        const historyBefore = afterImplement.workItem.stepRuns.length

        yield* sql.unsafe(
          `UPDATE work_item
           SET state = 'needs_human',
               failure_code = 'needs_human',
               failure_message = ?,
               holds_worker_slot = 0,
               waiting_since = NULL,
               pull_request_number = 952,
               session_id = 'ses_merge_assessment',
               worktree_path = '/tmp/worktrees/acme-widgets-42'
           WHERE id = ?`,
          [HANDOFF_REASON, created.id],
        )
        const latest = afterImplement.workItem.stepRuns.at(-1)
        expect(latest).toBeDefined()
        yield* sql.unsafe(
          `UPDATE step_run
           SET step = 'decide_pr_merge',
               status = 'succeeded',
               reason_code = NULL,
               reason_message = NULL,
               queue_job_id = NULL,
               finished_at = ?
           WHERE id = ?`,
          [Date.now(), latest!.id],
        )
        yield* sql.unsafe(`DELETE FROM job_queue`)

        const parked = yield* lifecycle.getWorkItem(created.id)
        expect(parked.state).toBe("needs_human")
        expect(parked.stepRuns.at(-1)?.reasonCode).toBeNull()
        expect(calls.decide).toBe(0)
        expect(calls.merge).toBe(0)

        const resumed = yield* lifecycle.resume(created.id)
        expect(resumed.state).toBe("decide_pr_merge")
        expect(resumed.sessionId).toBe("ses_merge_assessment")
        expect(resumed.pullRequestNumber).toBe(952)
        expect(resumed.failureCode).toBeNull()
        expect(resumed.stepRuns.length).toBe(historyBefore + 1)
        expect(resumed.stepRuns.at(-1)).toMatchObject({
          step: "decide_pr_merge",
          status: "queued",
        })
        expect(
          resumed.stepRuns.filter(
            (run) => run.status === "queued" || run.status === "running",
          ),
        ).toHaveLength(1)
        expect(calls.implement).toBe(1)
        expect(calls.createPr).toBe(0)

        const again = yield* lifecycle.resume(created.id)
        expect(
          again.stepRuns.filter(
            (run) => run.status === "queued" || run.status === "running",
          ),
        ).toHaveLength(1)
        expect(
          again.stepRuns.filter((run) => run.step === "decide_pr_merge"),
        ).toHaveLength(2)

        const stillUnresolved = yield* claimAndRunPending
        expect(stillUnresolved._tag).toBe("processed")
        if (stillUnresolved._tag !== "processed") {
          return
        }
        expect(stillUnresolved.workItem.state).toBe("needs_human")
        expect(stillUnresolved.workItem.failureMessage).toBe(
          "deployment freeze still applies",
        )
        expect(stillUnresolved.workItem.pullRequestNumber).toBe(952)
        expect(lastDecideContext).toEqual({
          sessionId: "ses_merge_assessment",
          recordedReason: HANDOFF_REASON,
          resumed: true,
        })
        expect(calls.merge).toBe(0)

        decideMode = "clanker_merge"
        const resumedAgain = yield* lifecycle.resume(
          stillUnresolved.workItem.id,
        )
        expect(resumedAgain.state).toBe("decide_pr_merge")
        const approved = yield* claimAndRunPending
        expect(approved._tag).toBe("processed")
        if (approved._tag !== "processed") {
          return
        }
        expect(approved.workItem.state).toBe("merge_pr")
        expect(approved.workItem.pullRequestNumber).toBe(952)
        expect(calls.implement).toBe(1)
        expect(calls.createPr).toBe(0)
        expect(lastDecideContext?.resumed).toBe(true)
        expect(lastDecideContext?.recordedReason).toBe(
          "deployment freeze still applies",
        )

        const revalidated = yield* claimAndRunPending
        expect(revalidated._tag).toBe("processed")
        if (revalidated._tag !== "processed") {
          return
        }
        expect(calls.merge).toBe(1)
        expect(revalidated.workItem.state).toBe("watch_pr_status_checks")
        expect(revalidated.workItem.state).not.toBe("complete")
        expect(revalidated.workItem.pullRequestNumber).toBe(952)
      }).pipe(Effect.provide(layer)),
    )
  })

  it("waits for an ordinary Worker Slot instead of starting a second assessment", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const db = yield* DbService
        const sql = yield* SqlClient.SqlClient
        const config = yield* db.getConfig
        yield* db.updateConfig({
          selectedAgentBackend: "opencode",
          defaultModel: config.defaultModel ?? "opencode/test",
          defaultThinkingLevel: config.defaultThinkingLevel ?? "low",
          reviewModel: config.reviewModel,
          reviewThinkingLevel: config.reviewThinkingLevel,
          maxConcurrentAgentTurns: config.maxConcurrentAgentTurns,
          maxConcurrentWorkItems: 1,
        })
        const { repository, issue } = yield* seedIssue(949)
        const occupant = yield* lifecycle.implementNow(
          repository.id,
          issue.nativeId,
        )
        expect(occupant.holdsWorkerSlot).toBe(true)

        const blockedIssue = yield* db.storeIssue({
          repositoryId: repository.id,
          issueNumber: 950,
          title: "Also waiting",
          body: "Second issue",
          url: "https://github.com/acme/widgets/issues/950",
          state: "OPEN",
          githubCreatedAt: new Date("2026-01-15T12:00:00.000Z"),
          issueAuthor: null,
          parent: null,
          parentPosition: null,
          hasChildren: false,
          blockedBy: [],
        })
        const waiting = yield* lifecycle.implementNow(
          repository.id,
          blockedIssue.nativeId,
        )
        expect(waiting.holdsWorkerSlot).toBe(false)
        yield* sql.unsafe(
          `UPDATE work_item
           SET state = 'needs_human',
               failure_code = 'needs_human',
               failure_message = ?,
               holds_worker_slot = 0,
               waiting_since = NULL,
               session_id = 'ses_waiting',
               worktree_path = '/tmp/worktrees/waiting',
               pull_request_number = 953
           WHERE id = ?`,
          [HANDOFF_REASON, waiting.id],
        )
        yield* sql.unsafe(
          `INSERT INTO step_run (
             id, work_item_id, step, status, queue_job_id, queued_at,
             started_at, finished_at, reason_code, reason_message,
             created_at, updated_at
           ) VALUES (?, ?, 'decide_pr_merge', 'succeeded', NULL, ?, ?, ?, NULL, NULL, ?, ?)`,
          [
            "srun-merge-handoff",
            waiting.id,
            Date.now(),
            Date.now(),
            Date.now(),
            Date.now(),
            Date.now(),
          ],
        )

        const resumed = yield* lifecycle.resume(waiting.id)
        expect(resumed.state).toBe("decide_pr_merge")
        expect(resumed.waitingSince).not.toBeNull()
        expect(resumed.holdsWorkerSlot).toBe(false)
        expect(
          resumed.stepRuns.filter(
            (run) => run.status === "queued" || run.status === "running",
          ),
        ).toHaveLength(0)
        expect(resumed.sessionId).toBe("ses_waiting")
        expect(resumed.pullRequestNumber).toBe(953)
      }).pipe(Effect.provide(layer)),
    )
  })

  it("does not resume a competing pull request stop or an implementation decision as a merge assessment", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const sql = yield* SqlClient.SqlClient
        const { repository, issue } = yield* seedIssue(951)
        const created = yield* lifecycle.implementNow(
          repository.id,
          issue.nativeId,
        )
        yield* sql.unsafe(
          `UPDATE work_item
           SET state = 'needs_human',
               failure_code = 'issue_closing_pull_request_unowned',
               failure_message = 'A competing pull request is open'
           WHERE id = ?`,
          [created.id],
        )
        const latest = created.stepRuns.at(-1)
        if (latest !== undefined) {
          yield* sql.unsafe(
            `UPDATE step_run
             SET step = 'decide_pr_merge', status = 'succeeded', finished_at = ?
             WHERE id = ?`,
            [Date.now(), latest.id],
          )
        }
        const blocked = yield* Effect.flip(lifecycle.resume(created.id))
        expect(blocked).toBeInstanceOf(ResumeNotEligibleError)
      }).pipe(Effect.provide(layer)),
    )
  })

  it("does not treat a later automatic reassessment as an operator Resume", async () => {
    decideMode = "clanker_merge"
    lastDecideContext = null
    await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const sql = yield* SqlClient.SqlClient
        const { repository, issue } = yield* seedIssue(954)
        const created = yield* lifecycle.implementNow(
          repository.id,
          issue.nativeId,
        )
        yield* claimAndRunPending
        yield* claimAndRunPending
        const afterImplement = yield* claimAndRunPending
        expect(afterImplement._tag).toBe("processed")
        if (afterImplement._tag !== "processed") {
          return
        }
        const now = Date.now()
        yield* sql.unsafe(`DELETE FROM job_queue`)
        yield* sql.unsafe(
          `UPDATE work_item
           SET state = 'decide_pr_merge',
               failure_code = NULL,
               failure_message = NULL,
               holds_worker_slot = 0,
               waiting_since = NULL,
               paused = 0,
               session_id = 'ses_merge_assessment',
               worktree_path = '/tmp/worktrees/acme-widgets-42',
               pull_request_number = 952
           WHERE id = ?`,
          [created.id],
        )
        const latest = afterImplement.workItem.stepRuns.at(-1)
        expect(latest).toBeDefined()
        yield* sql.unsafe(
          `UPDATE step_run
           SET step = 'decide_pr_merge',
               status = 'failed',
               queue_job_id = NULL,
               queued_at = ?,
               finished_at = ?,
               reason_code = 'handler_failed',
               reason_message = 'temporary failure'
           WHERE id = ?`,
          [now, now, latest!.id],
        )
        yield* sql.unsafe(
          `INSERT INTO step_run (
             id, work_item_id, step, status, queue_job_id, queued_at,
             started_at, finished_at, reason_code, reason_message,
             created_at, updated_at
           ) VALUES
             (?, ?, 'decide_pr_merge', 'succeeded', NULL, ?, ?, ?, NULL, ?, ?, ?),
             (?, ?, 'watch_pr_status_checks', 'succeeded', NULL, ?, ?, ?, 'native', NULL, ?, ?)`,
          [
            "srun-prior-decide",
            created.id,
            now - 3_000,
            now - 3_000,
            now - 2_000,
            HANDOFF_REASON,
            now - 3_000,
            now - 2_000,
            "srun-later-watch",
            created.id,
            now - 2_000,
            now - 2_000,
            now - 1_000,
            now - 2_000,
            now - 1_000,
          ],
        )

        const retried = yield* lifecycle.retry(created.id)
        expect(retried.stepRuns.at(-1)).toMatchObject({
          step: "decide_pr_merge",
          status: "queued",
        })
        const reassessed = yield* claimAndRunPending
        expect(reassessed._tag).toBe("processed")
        expect(lastDecideContext).toEqual({
          sessionId: "ses_merge_assessment",
          recordedReason: null,
          resumed: false,
        })
      }).pipe(Effect.provide(layer)),
    )
  })
})
