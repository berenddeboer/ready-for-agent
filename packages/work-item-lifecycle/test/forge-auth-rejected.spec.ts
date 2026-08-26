import { Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { AzureDevOpsRequestError } from "@ready-for-agent/azure-devops-service"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import { GitHubRequestError } from "@ready-for-agent/github-service"
import { GitLabRequestError } from "@ready-for-agent/gitlab-service"
import { QueueService } from "@ready-for-agent/queue-service"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
  CreatePrPostconditionError,
  LifecycleSteps,
  type LifecycleStepsShape,
  MarkPrReadyForReviewPostconditionError,
  RetryNotEligibleError,
  STEP_RUN_REASON,
  WORK_ITEM_LIFECYCLE_QUEUE,
  WorkItemLifecycle,
  WorkItemLifecycleLive,
  type WorkItemRecord,
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

const seedIssue = Effect.gen(function* () {
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

const forgetCreatePrDraftProvenance = (workItemId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(
      `UPDATE work_item
       SET check_start_last_observed_is_draft = NULL,
           check_start_anchor_at = 0
       WHERE id = ?`,
      [workItemId],
    )
  })

const runUntilLatestFailed = Effect.gen(function* () {
  const lifecycle = yield* WorkItemLifecycle
  const { repository, issue } = yield* seedIssue
  const created = yield* lifecycle.implementNow(
    repository.id,
    issue.issueNumber,
  )
  let current: WorkItemRecord = created
  for (let index = 0; index < 8; index += 1) {
    const result = yield* claimAndRunPending
    expect(result._tag).toBe("processed")
    if (result._tag !== "processed") {
      return yield* Effect.die("expected processed step")
    }
    current = result.workItem
    if (current.stepRuns.at(-1)?.status === "failed") {
      return current
    }
  }
  yield* forgetCreatePrDraftProvenance(current.id)
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const result = yield* claimAndRunPending
    expect(result._tag).toBe("processed")
    if (result._tag !== "processed") {
      return yield* Effect.die("expected processed step")
    }
    current = result.workItem
    if (current.stepRuns.at(-1)?.status === "failed") {
      return current
    }
  }
  return yield* Effect.die(
    `expected a failed Step Run, last state ${current.state}`,
  )
})

const countPermits = (workItemId: string, step: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = (yield* sql.unsafe(
      `SELECT COUNT(*) AS count FROM autonomous_retry
       WHERE work_item_id = ? AND lifecycle_step = ?`,
      [workItemId, step],
    )) as readonly { readonly count: number }[]
    return Number(rows[0]?.count ?? 0)
  })

const expectForgeAuthRejected = (workItem: WorkItemRecord, status: number) => {
  const latest = workItem.stepRuns.at(-1)
  expect(latest?.status).toBe("failed")
  expect(latest?.reasonCode).toBe(STEP_RUN_REASON.forgeAuthRejected)
  expect(latest?.reasonMessage).toContain(`HTTP ${String(status)}`)
}

describe("deterministic Forge 401/403 classification (issue #1218)", () => {
  it("classifies Azure MERGE_PR 401 as non-retryable and does not consume Autonomous Retry Budget", () => {
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      mergePr: () =>
        Effect.fail(
          new AzureDevOpsRequestError({
            message: "Failed to merge pull request 42 for acme/widgets",
            statusCode: 401,
            cause: Object.assign(
              new Error(
                "Failed to merge pull request 42 for acme/widgets: Azure DevOps returned HTTP 401",
              ),
              { statusCode: 401 },
            ),
          }),
        ),
    }

    return runWithSteps(
      steps,
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const failed = yield* runUntilLatestFailed
        expect(failed.state).toBe("merge_pr")
        expectForgeAuthRejected(failed, 401)

        const blocked = yield* Effect.flip(
          lifecycle.retry(failed.id, { autonomous: { maxRetries: 3 } }),
        )
        expect(blocked).toBeInstanceOf(RetryNotEligibleError)
        if (blocked instanceof RetryNotEligibleError) {
          expect(blocked.reason).toBe(STEP_RUN_REASON.forgeAuthRejected)
        }
        expect(yield* countPermits(failed.id, "merge_pr")).toBe(0)
      }),
    )
  })

  it("keeps a transient Azure MERGE_PR 503 retryable and still consumes Autonomous Retry Budget", () => {
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      mergePr: () =>
        Effect.fail(
          new AzureDevOpsRequestError({
            message: "Failed to merge pull request 42 for acme/widgets",
            statusCode: 503,
          }),
        ),
    }

    return runWithSteps(
      steps,
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const failed = yield* runUntilLatestFailed
        expect(failed.state).toBe("merge_pr")
        const latest = failed.stepRuns.at(-1)
        expect(latest?.status).toBe("failed")
        expect(latest?.reasonCode).toBe(STEP_RUN_REASON.handlerFailed)
        expect(latest?.reasonMessage).toContain("HTTP 503")

        const retried = yield* lifecycle.retry(failed.id, {
          autonomous: { maxRetries: 3 },
        })
        expect(retried.stepRuns.at(-1)?.status).toBe("queued")
        expect(yield* countPermits(failed.id, "merge_pr")).toBe(1)
      }),
    )
  })

  it("classifies GitHub Create PR 401 the same way, including wrapped postcondition diagnostics", () => {
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      createPr: () =>
        Effect.fail(
          new CreatePrPostconditionError({
            repositoryId: "repo-1",
            message:
              "No open pull request found for acme/widgets:branch after native attempt and agent fallback",
            diagnostics:
              "createDraftPullRequest failed: Failed to create draft pull request for acme/widgets:branch: HTTP 401 Unauthorized",
          }),
        ),
    }

    return runWithSteps(
      steps,
      Effect.gen(function* () {
        const failed = yield* runUntilLatestFailed
        expect(failed.state).toBe("create_pr")
        expectForgeAuthRejected(failed, 401)
      }),
    )
  })

  it("classifies GitLab Mark PR Ready for Review 403 as non-retryable", () => {
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      watchPrStatusChecks: () =>
        Effect.succeed({
          _tag: "succeeded",
          createdAt: new Date(0),
          headSha: "head",
          headPushedAt: new Date(0),
          isDraft: true,
        }),
      markPrReadyForReview: () =>
        Effect.fail(
          new MarkPrReadyForReviewPostconditionError({
            repositoryId: "repo-1",
            message:
              "Pull request for acme/widgets:branch is still a draft after native attempt and agent fallback",
            diagnostics:
              "markPullRequestReadyForReview failed: Failed to mark merge request ready for acme/widgets: HTTP 403 Forbidden",
          }),
        ),
    }

    return runWithSteps(
      steps,
      Effect.gen(function* () {
        const failed = yield* runUntilLatestFailed
        expect(failed.state).toBe("mark_pr_ready_for_review")
        expectForgeAuthRejected(failed, 403)
      }),
    )
  })

  it("classifies GitHub close-out 401 as non-retryable", () => {
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      assessChanges: () =>
        Effect.succeed({
          _tag: "no_change" as const,
          completionSummary: "Findings only.",
        }),
      closeIssue: () =>
        Effect.fail(
          new GitHubRequestError({
            message: "Failed to close issue #42 for acme/widgets",
            statusCode: 401,
          }),
        ),
    }

    return runWithSteps(
      steps,
      Effect.gen(function* () {
        const failed = yield* runUntilLatestFailed
        expect(failed.state).toBe("close_issue")
        expectForgeAuthRejected(failed, 401)
      }),
    )
  })

  it("classifies GitLab MERGE_PR 403 as non-retryable", () => {
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      mergePr: () =>
        Effect.fail(
          new GitLabRequestError({
            message: "Failed to merge merge request for acme/widgets",
            statusCode: 403,
          }),
        ),
    }

    return runWithSteps(
      steps,
      Effect.gen(function* () {
        const failed = yield* runUntilLatestFailed
        expect(failed.state).toBe("merge_pr")
        expectForgeAuthRejected(failed, 403)
      }),
    )
  })

  it("keeps a transport failure without an HTTP status as retryable handler_failed", () => {
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      mergePr: () =>
        Effect.fail(
          new AzureDevOpsRequestError({
            message: "Failed to merge pull request 42 for acme/widgets",
            code: "ENOTFOUND",
          }),
        ),
    }

    return runWithSteps(
      steps,
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const failed = yield* runUntilLatestFailed
        expect(failed.stepRuns.at(-1)?.reasonCode).toBe(
          STEP_RUN_REASON.handlerFailed,
        )
        const retried = yield* lifecycle.retry(failed.id, {
          autonomous: { maxRetries: 3 },
        })
        expect(retried.stepRuns.at(-1)?.status).toBe("queued")
        expect(yield* countPermits(failed.id, "merge_pr")).toBe(1)
      }),
    )
  })
})
