import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Clock, Duration, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { AgentBackend } from "@ready-for-agent/agent-backend"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import { QueueService } from "@ready-for-agent/queue-service"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
  LifecycleSteps,
  type LifecycleStepsShape,
  MAX_REVIEW_FIX_ROUNDS,
  REVIEW_FIX_LIMIT_REASON,
  REVIEW_PROGRESS_CHECKPOINT_KIND,
  STEP_RUN_REASON,
  WORK_ITEM_LIFECYCLE_QUEUE,
  WorkItemLifecycle,
  formatReviewNoProgressTimeoutMessage,
  makeWorkItemLifecycleLive,
  review,
  stubActiveAgentBackendLayer,
  stubAzureDevOpsServiceLayer,
  stubGitHubServiceLayer,
  stubGitLabServiceLayer,
} from "../src/index.js"
import { describe, expect, it, setDefaultTimeout } from "bun:test"

setDefaultTimeout(30_000)

const PlatformLayer = BunServices.layer
const REVIEW_INTERVAL = Duration.millis(120)

const successfulSteps: LifecycleStepsShape = {
  createWorktree: () =>
    Effect.succeed({
      worktreePath: "/tmp/worktrees/review-timeout",
      startingCommitOid: "abc123",
    }),
  installDependencies: () => Effect.void,
  implement: () => Effect.succeed("ses_implement_session"),
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
  markPrReadyForReview: () => Effect.succeed({ completion: "native" as const }),
  decidePrMerge: () => Effect.succeed({ _tag: "clanker_merge" }),
  mergePr: () => Effect.succeed({ _tag: "merged" }),
  closeIssue: () => Effect.void,
  localCleanup: () => Effect.void,
  removeWorktree: () => Effect.void,
}

const stubOpencode = (
  continueTurn: (input: {
    readonly sessionId: string
    readonly prompt: string
    readonly cwd: string
    readonly model: string
    readonly thinkingLevel: string
    readonly timeout?: Duration.Input
    readonly command?: string
  }) => Effect.Effect<{ sessionId: string; assistantText: string }, never>,
) =>
  Layer.succeed(
    AgentBackend,
    AgentBackend.of({
      startTurn: () =>
        Effect.succeed({
          sessionId: "ses_start_should_not_run",
          assistantText: "",
        }),
      continueTurn: (input) => continueTurn(input),
      inspect: () =>
        Effect.succeed({
          backend: { id: "opencode" as const, label: "OpenCode" },
          models: [],
        }),
    }),
  )

const reviewSteps = (
  worktreePath: string,
  continueTurn: Parameters<typeof stubOpencode>[0],
): LifecycleStepsShape => ({
  ...successfulSteps,
  createWorktree: () =>
    Effect.succeed({
      worktreePath,
      startingCommitOid: "abc123",
    }),
  review: (context) =>
    review(context).pipe(
      Effect.provide(stubOpencode(continueTurn)),
      Effect.provide(PlatformLayer),
    ),
})

const maxDurations = {
  create_worktree: Duration.minutes(5),
  install_dependencies: Duration.minutes(15),
  implement: Duration.hours(2),
  assess_changes: Duration.minutes(5),
  pre_commit: Duration.hours(2),
  review: REVIEW_INTERVAL,
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
}

const makeLayer = (steps: LifecycleStepsShape) =>
  makeWorkItemLifecycleLive({ maxDurations }).pipe(
    Layer.provideMerge(stubActiveAgentBackendLayer()),
    Layer.provideMerge(stubGitHubServiceLayer()),
    Layer.provideMerge(stubGitLabServiceLayer()),
    Layer.provideMerge(stubAzureDevOpsServiceLayer()),
    Layer.provideMerge(Layer.succeed(LifecycleSteps, LifecycleSteps.of(steps))),
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

const seedActionableIssue = Effect.gen(function* () {
  const db = yield* DbService
  const config = yield* db.getConfig
  if (config.defaultModel === null || config.defaultThinkingLevel === null) {
    yield* db.updateConfig({
      selectedAgentBackend: "opencode",
      defaultModel: config.defaultModel ?? "opencode/deepseek-v4-flash-free",
      defaultThinkingLevel: config.defaultThinkingLevel ?? "low",
      reviewModel: config.reviewModel,
      reviewThinkingLevel: config.reviewThinkingLevel,
      maxConcurrentAgentTurns: config.maxConcurrentAgentTurns,
      maxConcurrentWorkItems: config.maxConcurrentWorkItems,
    })
  }
  const repository = yield* db.addRepository({
    forge: "github",
    forgeHost: "github.com",
    projectPath: "acme/widgets",
    localPath: "/repos/acme/widgets.git",
    isBare: true,
  })
  const issue = yield* db.storeIssue({
    repositoryId: repository.id,
    issueNumber: 42,
    title: "Implement feature",
    body: "Issue body",
    url: "https://github.com/acme/widgets/issues/42",
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

const driveToQueuedReview = Effect.gen(function* () {
  const lifecycle = yield* WorkItemLifecycle
  const { repository, issue } = yield* seedActionableIssue
  const created = yield* lifecycle.implementNow(
    repository.id,
    issue.issueNumber,
  )
  for (let index = 0; index < 5; index += 1) {
    const result = yield* claimAndRunPending
    expect(result._tag).toBe("processed")
  }
  const beforeReview = yield* lifecycle.getWorkItem(created.id)
  expect(beforeReview.state).toBe("review")
  expect(beforeReview.stepRuns.at(-1)?.status).toBe("queued")
  return beforeReview
})

const initGitRepo = async (root: string) => {
  const runGit = async (...args: string[]) => {
    const proc = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], {
      cwd: root,
      stdout: "ignore",
      stderr: "pipe",
    })
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text()
      throw new Error(`git ${args.join(" ")} failed: ${stderr}`)
    }
  }
  await runGit("init")
  await runGit("config", "user.email", "test@example.com")
  await runGit("config", "user.name", "Test")
  await runGit("commit", "--no-verify", "--allow-empty", "-m", "init")
}

const writeHook = async (root: string, body: string) => {
  await mkdir(join(root, ".git", "hooks"), { recursive: true })
  await writeFile(join(root, ".git", "hooks", "pre-commit"), body, {
    mode: 0o755,
  })
}

const withTemp = async (assert: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "rfa-review-timeout-"))
  try {
    await assert(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const withTempGit = async (assert: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "rfa-review-timeout-git-"))
  try {
    await initGitRepo(root)
    await assert(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const isReviewingTurn = (prompt: string): boolean =>
  prompt.includes("READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS") &&
  prompt.includes("Do not edit files, commit, push")

const isApplyTurn = (prompt: string): boolean =>
  prompt.includes("READY_FOR_AGENT_RESULT: REVIEW_FIXED") &&
  prompt.includes("Interpret those findings")

const simulateAdmissionWait = (
  sql: SqlClient.SqlClient,
  duration: Duration.Duration,
) =>
  Effect.gen(function* () {
    const rows = (yield* sql.unsafe(
      `SELECT id FROM step_run WHERE status = 'running' LIMIT 1`,
    )) as readonly { readonly id: string }[]
    const stepRunId = rows[0]?.id
    if (stepRunId === undefined) {
      return
    }
    const waitStart = yield* Clock.currentTimeMillis
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
    yield* Effect.sleep(duration)
    const waitEnd = yield* Clock.currentTimeMillis
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
  })

describe("Review no-progress timeout", () => {
  it("times out when the first reviewing pass never reaches a checkpoint", () =>
    withTemp(async (root) =>
      runWithSteps(
        reviewSteps(root, () =>
          Effect.gen(function* () {
            yield* Effect.sleep(Duration.millis(250))
            return {
              sessionId: "ses_implement_session",
              assistantText: "still looking around with tools",
            }
          }),
        ),
        Effect.gen(function* () {
          yield* driveToQueuedReview
          const result = yield* claimAndRunPending
          expect(result._tag).toBe("processed")
          if (result._tag !== "processed") {
            return
          }
          const run = result.workItem.stepRuns.at(-1)!
          expect(result.workItem.state).toBe("review")
          expect(run.status).toBe("failed")
          expect(run.reasonCode).toBe(STEP_RUN_REASON.timeout)
          expect(run.reasonMessage).toBe(
            formatReviewNoProgressTimeoutMessage({
              interval: REVIEW_INTERVAL,
              checkpointKind: null,
              checkpointAt: null,
            }),
          )
        }),
      ),
    ))

  it("succeeds past the interval when accepted reviewing checkpoints renew it", () =>
    withTemp(async (root) => {
      let reviewingTurns = 0
      return runWithSteps(
        reviewSteps(root, (input) =>
          Effect.gen(function* () {
            if (isReviewingTurn(input.prompt)) {
              reviewingTurns += 1
              yield* Effect.sleep(Duration.millis(80))
              return {
                sessionId: "ses_implement_session",
                assistantText:
                  reviewingTurns === 1
                    ? "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: low"
                    : "READY_FOR_AGENT_RESULT: REVIEW_CLEAN",
              }
            }
            return {
              sessionId: "ses_implement_session",
              assistantText:
                "READY_FOR_AGENT_RESULT: REVIEW_DEFERRED: low: later",
            }
          }),
        ),
        Effect.gen(function* () {
          yield* driveToQueuedReview
          const result = yield* claimAndRunPending
          expect(result._tag).toBe("processed")
          if (result._tag !== "processed") {
            return
          }
          expect(result.workItem.state).toBe("commit")
          expect(
            result.workItem.stepRuns.find((run) => run.step === "review")
              ?.status,
          ).toBe("succeeded")
        }),
      )
    }))

  it("does not treat malformed verdicts or commentary as progress", () =>
    withTemp(async (root) => {
      let turn = 0
      return runWithSteps(
        reviewSteps(root, () =>
          Effect.gen(function* () {
            turn += 1
            yield* Effect.sleep(Duration.millis(70))
            return {
              sessionId: "ses_implement_session",
              assistantText:
                turn === 1
                  ? "commentary and tool noise without a marker"
                  : "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: potato",
            }
          }),
        ),
        Effect.gen(function* () {
          yield* driveToQueuedReview
          const result = yield* claimAndRunPending
          expect(result._tag).toBe("processed")
          if (result._tag !== "processed") {
            return
          }
          const run = result.workItem.stepRuns.at(-1)!
          expect(run.status).toBe("failed")
          expect(run.reasonCode).toBe(STEP_RUN_REASON.timeout)
          expect(run.reasonMessage).toContain("no checkpoint has completed")
        }),
      )
    }))

  it("does not renew on a fix verdict until nested Pre-Commit succeeds", () =>
    withTempGit(async (root) => {
      await writeHook(
        root,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          "printf '%s\\n' 'hook still failing' >&2",
          "exit 1",
          "",
        ].join("\n"),
      )
      await writeFile(join(root, "change.txt"), "pending\n")
      return runWithSteps(
        reviewSteps(root, (input) =>
          Effect.gen(function* () {
            if (isReviewingTurn(input.prompt)) {
              return {
                sessionId: "ses_implement_session",
                assistantText:
                  "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: medium",
              }
            }
            if (isApplyTurn(input.prompt)) {
              yield* Effect.promise(async () => {
                await writeFile(join(root, "change.txt"), "fixed-unverified\n")
              })
              return {
                sessionId: "ses_implement_session",
                assistantText: "READY_FOR_AGENT_RESULT: REVIEW_FIXED",
              }
            }
            yield* Effect.sleep(Duration.millis(250))
            return {
              sessionId: "ses_implement_session",
              assistantText: "still fixing hooks",
            }
          }),
        ),
        Effect.gen(function* () {
          yield* driveToQueuedReview
          const result = yield* claimAndRunPending
          expect(result._tag).toBe("processed")
          if (result._tag !== "processed") {
            return
          }
          const run = result.workItem.stepRuns.find(
            (stepRun) => stepRun.step === "review",
          )!
          expect(run.status).toBe("failed")
          expect(run.reasonCode).toBe(STEP_RUN_REASON.timeout)
          expect(run.reasonMessage).toContain("last checkpoint: reviewing")
          expect(run.reasonMessage).not.toContain("verified apply")
        }),
      )
    }))

  it("renews after nested Pre-Commit succeeds on changed work", () =>
    withTempGit(async (root) => {
      await writeHook(root, "#!/usr/bin/env bash\nexit 0\n")
      await writeFile(join(root, "change.txt"), "pending\n")
      let reviewingTurns = 0
      return runWithSteps(
        reviewSteps(root, (input) =>
          Effect.gen(function* () {
            if (isReviewingTurn(input.prompt)) {
              reviewingTurns += 1
              yield* Effect.sleep(Duration.millis(80))
              return {
                sessionId: "ses_implement_session",
                assistantText:
                  reviewingTurns === 1
                    ? "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: medium"
                    : "READY_FOR_AGENT_RESULT: REVIEW_CLEAN",
              }
            }
            yield* Effect.promise(async () => {
              await writeFile(join(root, "change.txt"), "fixed\n")
            })
            return {
              sessionId: "ses_implement_session",
              assistantText: "READY_FOR_AGENT_RESULT: REVIEW_FIXED",
            }
          }),
        ),
        Effect.gen(function* () {
          yield* driveToQueuedReview
          const result = yield* claimAndRunPending
          expect(result._tag).toBe("processed")
          if (result._tag !== "processed") {
            return
          }
          expect(result.workItem.state).toBe("commit")
        }),
      )
    }))

  it("does not timeout solely for admission waiting before or after a checkpoint", () =>
    withTemp(async (root) =>
      runWithSteps(
        reviewSteps(root, (input) =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            if (isReviewingTurn(input.prompt)) {
              yield* simulateAdmissionWait(sql, Duration.millis(200))
              return {
                sessionId: "ses_implement_session",
                assistantText:
                  "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: low",
              }
            }
            yield* simulateAdmissionWait(sql, Duration.millis(200))
            return {
              sessionId: "ses_implement_session",
              assistantText:
                "READY_FOR_AGENT_RESULT: REVIEW_DEFERRED: low: later",
            }
          }),
        ),
        Effect.gen(function* () {
          yield* driveToQueuedReview
          const result = yield* claimAndRunPending
          expect(result._tag).toBe("processed")
          if (result._tag !== "processed") {
            return
          }
          expect(result.workItem.state).toBe("commit")
        }),
      ),
    ))

  it("does not subtract pre-checkpoint waiting from the renewed interval", () =>
    withTemp(async (root) =>
      runWithSteps(
        reviewSteps(root, (input) =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            if (isReviewingTurn(input.prompt)) {
              yield* simulateAdmissionWait(sql, Duration.millis(200))
              return {
                sessionId: "ses_implement_session",
                assistantText:
                  "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: low",
              }
            }
            yield* Effect.sleep(Duration.millis(200))
            return {
              sessionId: "ses_implement_session",
              assistantText:
                "READY_FOR_AGENT_RESULT: REVIEW_DEFERRED: low: later",
            }
          }),
        ),
        Effect.gen(function* () {
          yield* driveToQueuedReview
          const result = yield* claimAndRunPending
          expect(result._tag).toBe("processed")
          if (result._tag !== "processed") {
            return
          }
          const run = result.workItem.stepRuns.find(
            (stepRun) => stepRun.step === "review",
          )!
          expect(run.status).toBe("failed")
          expect(run.reasonCode).toBe(STEP_RUN_REASON.timeout)
          expect(run.reasonMessage).toContain("last checkpoint: reviewing")
        }),
      ),
    ))

  it("still hands off at six Review Fix Rounds after checkpoints", () =>
    withTempGit(async (root) => {
      await writeHook(root, "#!/usr/bin/env bash\nexit 0\n")
      await writeFile(join(root, "change.txt"), "pending\n")
      let reviewingTurns = 0
      return runWithSteps(
        reviewSteps(root, (input) =>
          Effect.gen(function* () {
            if (isReviewingTurn(input.prompt)) {
              reviewingTurns += 1
              return {
                sessionId: "ses_implement_session",
                assistantText:
                  "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: medium",
              }
            }
            yield* Effect.promise(async () => {
              await writeFile(
                join(root, "change.txt"),
                `fixed-${String(reviewingTurns)}\n`,
              )
            })
            return {
              sessionId: "ses_implement_session",
              assistantText: "READY_FOR_AGENT_RESULT: REVIEW_FIXED",
            }
          }),
        ),
        Effect.gen(function* () {
          yield* driveToQueuedReview
          const result = yield* claimAndRunPending
          expect(result._tag).toBe("processed")
          if (result._tag !== "processed") {
            return
          }
          expect(result.workItem.state).toBe("needs_human")
          expect(result.workItem.failureMessage).toBe(REVIEW_FIX_LIMIT_REASON)
          expect(reviewingTurns).toBe(MAX_REVIEW_FIX_ROUNDS + 1)
        }),
      )
    }))

  it("keeps timeout retryable with a fresh budget and preserved Session", () =>
    withTemp(async (root) => {
      let attempts = 0
      return runWithSteps(
        reviewSteps(root, () =>
          Effect.gen(function* () {
            attempts += 1
            if (attempts === 1) {
              yield* Effect.sleep(Duration.millis(250))
              return {
                sessionId: "ses_implement_session",
                assistantText: "no verdict yet",
              }
            }
            return {
              sessionId: "ses_implement_session",
              assistantText: "READY_FOR_AGENT_RESULT: REVIEW_CLEAN",
            }
          }),
        ),
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const before = yield* driveToQueuedReview
          const timedOut = yield* claimAndRunPending
          expect(timedOut._tag).toBe("processed")
          if (timedOut._tag !== "processed") {
            return
          }
          expect(timedOut.workItem.stepRuns.at(-1)?.reasonCode).toBe(
            STEP_RUN_REASON.timeout,
          )
          expect(timedOut.workItem.sessionId).toBe("ses_implement_session")
          expect(timedOut.workItem.worktreePath).toBe(before.worktreePath)

          const retried = yield* lifecycle.retry(timedOut.workItem.id)
          expect(retried.stepRuns).toHaveLength(before.stepRuns.length + 1)
          expect(retried.stepRuns.at(-1)?.status).toBe("queued")
          expect(retried.stepRuns.at(-1)?.step).toBe("review")

          const recovered = yield* claimAndRunPending
          expect(recovered._tag).toBe("processed")
          if (recovered._tag !== "processed") {
            return
          }
          expect(recovered.workItem.state).toBe("commit")
        }),
      )
    }))

  it("recovers an overdue Review without minting a new interval", () =>
    withTemp(async (root) =>
      runWithSteps(
        reviewSteps(root, () =>
          Effect.succeed({
            sessionId: "ses_implement_session",
            assistantText: "READY_FOR_AGENT_RESULT: REVIEW_CLEAN",
          }),
        ),
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const queue = yield* QueueService
          const sql = yield* SqlClient.SqlClient
          const before = yield* driveToQueuedReview
          const stepRunId = before.stepRuns.at(-1)!.id
          const jobId = before.stepRuns.at(-1)!.queueJobId!
          const now = Date.now()
          yield* sql.unsafe(
            `UPDATE step_run
             SET status = 'running',
                 started_at = ?,
                 updated_at = ?
             WHERE id = ?`,
            [now - 1_000, now, stepRunId],
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
          expect(result._tag).toBe("processed")
          if (result._tag !== "processed") {
            return
          }
          const run = result.workItem.stepRuns.at(-1)!
          expect(run.status).toBe("failed")
          expect(run.reasonCode).toBe(STEP_RUN_REASON.timeout)
          expect(run.reasonMessage).toContain("no checkpoint has completed")
        }),
      ),
    ))

  it("uses a persisted checkpoint on recovery instead of the Step Run start", () =>
    withTemp(async (root) =>
      runWithSteps(
        reviewSteps(root, () =>
          Effect.succeed({
            sessionId: "ses_implement_session",
            assistantText: "READY_FOR_AGENT_RESULT: REVIEW_CLEAN",
          }),
        ),
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const queue = yield* QueueService
          const sql = yield* SqlClient.SqlClient
          const before = yield* driveToQueuedReview
          const stepRunId = before.stepRuns.at(-1)!.id
          const jobId = before.stepRuns.at(-1)!.queueJobId!
          const now = Date.now()
          yield* sql.unsafe(
            `UPDATE step_run
             SET status = 'running',
                 started_at = ?,
                 progress_checkpoint_at = ?,
                 progress_checkpoint_kind = ?,
                 progress_checkpoint_session_wait_ms = 0,
                 updated_at = ?
             WHERE id = ?`,
            [
              now - 5_000,
              now - 20,
              REVIEW_PROGRESS_CHECKPOINT_KIND.reviewing,
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
          const final = yield* lifecycle.getWorkItem(before.id)
          expect(final.stepRuns.at(-1)?.status).toBe("running")
        }),
      ),
    ))

  it("times out recovery when the persisted checkpoint is already overdue", () =>
    withTemp(async (root) =>
      runWithSteps(
        reviewSteps(root, () =>
          Effect.succeed({
            sessionId: "ses_implement_session",
            assistantText: "READY_FOR_AGENT_RESULT: REVIEW_CLEAN",
          }),
        ),
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const queue = yield* QueueService
          const sql = yield* SqlClient.SqlClient
          const before = yield* driveToQueuedReview
          const stepRunId = before.stepRuns.at(-1)!.id
          const jobId = before.stepRuns.at(-1)!.queueJobId!
          const now = Date.now()
          const checkpointAt = now - 1_000
          yield* sql.unsafe(
            `UPDATE step_run
             SET status = 'running',
                 started_at = ?,
                 progress_checkpoint_at = ?,
                 progress_checkpoint_kind = ?,
                 progress_checkpoint_session_wait_ms = 0,
                 updated_at = ?
             WHERE id = ?`,
            [
              now - 5_000,
              checkpointAt,
              REVIEW_PROGRESS_CHECKPOINT_KIND.verifiedApply,
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
          expect(result._tag).toBe("processed")
          if (result._tag !== "processed") {
            return
          }
          const run = result.workItem.stepRuns.at(-1)!
          expect(run.status).toBe("failed")
          expect(run.reasonCode).toBe(STEP_RUN_REASON.timeout)
          expect(run.reasonMessage).toBe(
            formatReviewNoProgressTimeoutMessage({
              interval: REVIEW_INTERVAL,
              checkpointKind: REVIEW_PROGRESS_CHECKPOINT_KIND.verifiedApply,
              checkpointAt,
            }),
          )
        }),
      ),
    ))
})
