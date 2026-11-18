import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import { STEP_RUN_REASON } from "@ready-for-agent/lifecycle-model"
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
  InvalidExecutionProfileError,
  LifecycleStepFailedError,
  WorkItemTerminalError,
} from "../src/lib/errors.js"
import { describe, expect, it } from "bun:test"

const catalog = [
  { id: "provider/build", thinkingLevels: ["low", "high"] },
  { id: "provider/review-a", thinkingLevels: ["low", "high"] },
  { id: "provider/review-b", thinkingLevels: ["low", "high", "max"] },
  { id: "provider/plain", thinkingLevels: [] },
]

let reviewAttempts = 0

const steps: LifecycleStepsShape = {
  createWorktree: () =>
    Effect.succeed({
      worktreePath: "/tmp/worktrees/acme-widgets-42",
      startingCommitOid: "abc123",
    }),
  installDependencies: () => Effect.void,
  implement: () => Effect.succeed("ses_test"),
  assessChanges: () => Effect.succeed({ _tag: "changes" }),
  preCommit: () => Effect.void,
  review: () => {
    reviewAttempts += 1
    if (reviewAttempts === 1) {
      return Effect.fail(
        new LifecycleStepFailedError({
          message: "misalignment_policy_violation",
        }),
      )
    }
    return Effect.succeed({ _tag: "clean" as const })
  },
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

const lifecycleLayer = WorkItemLifecycleLive.pipe(
  Layer.provideMerge(stubActiveAgentBackendLayer({ models: catalog })),
  Layer.provideMerge(stubGitHubServiceLayer()),
  Layer.provideMerge(stubGitLabServiceLayer()),
  Layer.provideMerge(stubAzureDevOpsServiceLayer()),
  Layer.provideMerge(stubLinearServiceLayer()),
  Layer.provideMerge(Layer.succeed(LifecycleSteps, LifecycleSteps.of(steps))),
  Layer.provideMerge(DbServiceLive),
  Layer.provideMerge(SqliteQueueServiceLive),
  Layer.provideMerge(DatabaseTest),
)

const readProfile = (sql: SqlClient.SqlClient, id: string) =>
  sql.unsafe(
    `SELECT agent_backend AS agentBackend,
            paused,
            state,
            execution_profile_present AS executionProfilePresent,
            execution_profile_build_model AS buildModel,
            execution_profile_build_thinking_level AS buildThinkingLevel,
            execution_profile_review_same_as_build AS reviewSameAsBuild,
            execution_profile_review_model AS reviewModel,
            execution_profile_review_thinking_level AS reviewThinkingLevel
     FROM work_item WHERE id = ?`,
    [id],
  )

const insertProfiledWorkItem = (
  sql: SqlClient.SqlClient,
  input: {
    readonly id: string
    readonly repositoryId: string
    readonly issueNumber: number
    readonly state?: string
    readonly paused?: number
    readonly present?: number
    readonly reviewSameAsBuild?: number
    readonly reviewModel?: string | null
    readonly reviewThinkingLevel?: string | null
  },
) => {
  const now = Date.now()
  const nativeId = String(input.issueNumber)
  return sql.unsafe(
    `INSERT INTO work_item (
       id, repository_id, issue_number, issue_tracker, issue_native_id, issue_display_id,
       state, state_ready_at, agent_backend, paused,
       execution_profile_present, execution_profile_build_model,
       execution_profile_build_thinking_level,
       execution_profile_review_same_as_build,
       execution_profile_review_model, execution_profile_review_thinking_level,
       created_at, updated_at
     ) VALUES (?, ?, ?, 'github', ?, ?, ?, ?, 'opencode', ?, ?, 'provider/build', 'high', ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.repositoryId,
      input.issueNumber,
      nativeId,
      nativeId,
      input.state ?? "review",
      now,
      input.paused ?? 0,
      input.present ?? 1,
      input.reviewSameAsBuild ?? 0,
      input.reviewModel === undefined ? "provider/review-a" : input.reviewModel,
      input.reviewThinkingLevel === undefined
        ? "high"
        : input.reviewThinkingLevel,
      now,
      now,
    ],
  )
}

describe("updateWorkItemExecutionProfile", () => {
  it("changes only the requested model and keeps a paused Work Item paused", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const sql = yield* SqlClient.SqlClient
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets.git",
          isBare: true,
        })
        yield* insertProfiledWorkItem(sql, {
          id: "wi-paused",
          repositoryId: repo.id,
          issueNumber: 1,
          paused: 1,
        })
        yield* insertProfiledWorkItem(sql, {
          id: "wi-build",
          repositoryId: repo.id,
          issueNumber: 2,
        })

        const reviewOnly = yield* lifecycle.updateWorkItemExecutionProfile(
          "wi-paused",
          { reviewModel: "provider/review-b", reviewThinkingLevel: "max" },
        )
        expect(reviewOnly.paused).toBe(true)
        expect(reviewOnly.state).toBe("review")
        expect(reviewOnly.executionProfile).toEqual({
          agentBackend: "opencode",
          build: { model: "provider/build", thinkingLevel: "high" },
          review: {
            kind: "explicit",
            model: "provider/review-b",
            thinkingLevel: "max",
          },
        })

        const buildOnly = yield* lifecycle.updateWorkItemExecutionProfile(
          "wi-build",
          { buildModel: "provider/build", buildThinkingLevel: "low" },
        )
        expect(buildOnly.executionProfile).toMatchObject({
          build: { model: "provider/build", thinkingLevel: "low" },
          review: {
            kind: "explicit",
            model: "provider/review-a",
            thinkingLevel: "high",
          },
        })

        const collapsed = yield* lifecycle.updateWorkItemExecutionProfile(
          "wi-build",
          { reviewSameAsBuild: true },
        )
        expect(collapsed.executionProfile?.review).toEqual({
          kind: "same_as_build",
        })
        const rows = (yield* readProfile(sql, "wi-build")) as ReadonlyArray<{
          readonly reviewSameAsBuild: number
          readonly reviewModel: string | null
          readonly reviewThinkingLevel: string | null
          readonly buildThinkingLevel: string
        }>
        expect(rows[0]).toMatchObject({
          reviewSameAsBuild: 1,
          reviewModel: null,
          reviewThinkingLevel: null,
          buildThinkingLevel: "low",
        })
      }).pipe(Effect.provide(lifecycleLayer)),
    )
  })

  it("keeps both fields when two partial updates overlap", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const sql = yield* SqlClient.SqlClient
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets.git",
          isBare: true,
        })
        yield* insertProfiledWorkItem(sql, {
          id: "wi-race",
          repositoryId: repo.id,
          issueNumber: 1,
        })

        yield* Effect.all(
          [
            lifecycle.updateWorkItemExecutionProfile("wi-race", {
              buildThinkingLevel: "low",
            }),
            lifecycle.updateWorkItemExecutionProfile("wi-race", {
              reviewModel: "provider/review-b",
              reviewThinkingLevel: "max",
            }),
          ],
          { concurrency: "unbounded" },
        )

        const final = yield* lifecycle.getWorkItem("wi-race")
        expect(final.executionProfile).toEqual({
          agentBackend: "opencode",
          build: { model: "provider/build", thinkingLevel: "low" },
          review: {
            kind: "explicit",
            model: "provider/review-b",
            thinkingLevel: "max",
          },
        })
      }).pipe(Effect.provide(lifecycleLayer)),
    )
  })

  it("rejects invalid models, stale thinking levels, missing pins, and closed Work Items", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const sql = yield* SqlClient.SqlClient
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets.git",
          isBare: true,
        })
        yield* insertProfiledWorkItem(sql, {
          id: "wi-open",
          repositoryId: repo.id,
          issueNumber: 1,
        })
        yield* insertProfiledWorkItem(sql, {
          id: "wi-human",
          repositoryId: repo.id,
          issueNumber: 2,
          state: "needs_human",
        })
        yield* insertProfiledWorkItem(sql, {
          id: "wi-done",
          repositoryId: repo.id,
          issueNumber: 3,
          state: "complete",
        })
        yield* insertProfiledWorkItem(sql, {
          id: "wi-failed",
          repositoryId: repo.id,
          issueNumber: 4,
          state: "failed",
        })
        yield* insertProfiledWorkItem(sql, {
          id: "wi-abandoned",
          repositoryId: repo.id,
          issueNumber: 5,
          state: "abandoned",
        })
        yield* insertProfiledWorkItem(sql, {
          id: "wi-ordinary",
          repositoryId: repo.id,
          issueNumber: 6,
          present: 0,
          reviewModel: null,
          reviewThinkingLevel: null,
        })

        const invalidModel = yield* Effect.flip(
          lifecycle.updateWorkItemExecutionProfile("wi-open", {
            reviewModel: "missing",
          }),
        )
        expect(invalidModel).toBeInstanceOf(InvalidExecutionProfileError)

        const staleLevel = yield* Effect.flip(
          lifecycle.updateWorkItemExecutionProfile("wi-open", {
            reviewModel: "provider/review-b",
            reviewThinkingLevel: "medium",
          }),
        )
        expect(staleLevel).toBeInstanceOf(InvalidExecutionProfileError)
        if (staleLevel instanceof InvalidExecutionProfileError) {
          expect(staleLevel.message).toContain("medium")
        }

        const human = yield* lifecycle.updateWorkItemExecutionProfile(
          "wi-human",
          { reviewModel: "provider/review-b", reviewThinkingLevel: "high" },
        )
        expect(human.state).toBe("needs_human")

        for (const id of ["wi-done", "wi-failed", "wi-abandoned"] as const) {
          const error = yield* Effect.flip(
            lifecycle.updateWorkItemExecutionProfile(id, {
              reviewModel: "provider/review-b",
            }),
          )
          expect(error).toBeInstanceOf(WorkItemTerminalError)
        }

        const missing = yield* Effect.flip(
          lifecycle.updateWorkItemExecutionProfile("wi-ordinary", {
            reviewModel: "provider/review-b",
          }),
        )
        expect(missing).toBeInstanceOf(InvalidExecutionProfileError)
      }).pipe(Effect.provide(lifecycleLayer)),
    )
  })

  it("retries a handler_failed review step on the new review model", async () => {
    reviewAttempts = 0
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const sql = yield* SqlClient.SqlClient
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets.git",
          isBare: true,
        })
        yield* db.updateConfig({
          selectedAgentBackend: "opencode",
          defaultModel: "provider/build",
          defaultThinkingLevel: "high",
          reviewModel: "provider/review-a",
          reviewThinkingLevel: "high",
          maxConcurrentAgentTurns: 2,
          maxConcurrentWorkItems: 5,
        })
        yield* db.storeIssue({
          repositoryId: repo.id,
          issueNumber: 1,
          title: "Issue",
          body: "body",
          url: "https://github.com/acme/widgets/issues/1",
          state: "OPEN",
          githubCreatedAt: new Date(),
          issueAuthor: null,
          parent: null,
          parentPosition: null,
          hasChildren: false,
          blockedBy: [],
        })
        const created = yield* lifecycle.implementNow(repo.id, "1")
        yield* sql.unsafe(
          `UPDATE work_item
           SET execution_profile_present = 1,
               execution_profile_build_model = 'provider/build',
               execution_profile_build_thinking_level = 'high',
               execution_profile_review_same_as_build = 0,
               execution_profile_review_model = 'provider/review-a',
               execution_profile_review_thinking_level = 'high'
           WHERE id = ?`,
          [created.id],
        )

        let current = yield* lifecycle.getWorkItem(created.id)
        for (let guard = 0; guard < 8; guard++) {
          const queued = current.stepRuns.find((run) => run.status === "queued")
          if (queued === undefined) break
          const result = yield* lifecycle.runStep(queued.id)
          if (result._tag !== "processed") {
            throw new Error(`expected ${queued.step} to process`)
          }
          current = result.workItem
          if (queued.step === "review") break
        }

        const failed = current.stepRuns.find((run) => run.step === "review")
        expect(failed?.status).toBe("failed")
        expect(failed?.reasonCode).toBe(STEP_RUN_REASON.handlerFailed)

        const changed = yield* lifecycle.updateWorkItemExecutionProfile(
          created.id,
          {
            reviewModel: "provider/review-b",
            reviewThinkingLevel: "high",
          },
        )
        expect(changed.executionProfile?.review).toEqual({
          kind: "explicit",
          model: "provider/review-b",
          thinkingLevel: "high",
        })

        const retried = yield* lifecycle.retry(created.id)
        const queued = retried.stepRuns.find((run) => run.status === "queued")
        expect(queued?.step).toBe("review")
        if (queued === undefined) {
          throw new Error("retry did not queue a review Step Run")
        }
        const rerun = yield* lifecycle.runStep(queued.id)
        expect(rerun._tag).toBe("processed")

        const rows = (yield* sql.unsafe(
          `SELECT sr.status, m.model
           FROM step_run sr
           INNER JOIN step_run_agent_model m ON m.step_run_id = sr.id
           WHERE sr.work_item_id = ? AND sr.step = 'review' AND m.role = 'review'
           ORDER BY sr.queued_at`,
          [created.id],
        )) as ReadonlyArray<{
          readonly status: string
          readonly model: string
        }>
        expect(rows).toEqual([
          { status: "failed", model: "provider/review-a" },
          { status: "succeeded", model: "provider/review-b" },
        ])
      }).pipe(Effect.provide(lifecycleLayer)),
    )
  })
})
