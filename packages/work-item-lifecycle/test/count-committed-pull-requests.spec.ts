import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbServiceLive } from "@ready-for-agent/db-service"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
  LifecycleSteps,
  type LifecycleStepsShape,
  WorkItemLifecycle,
  WorkItemLifecycleLive,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const successfulSteps: LifecycleStepsShape = {
  createWorktree: () =>
    Effect.succeed({
      worktreePath: "/tmp/worktrees/acme-widgets-42",
      startingCommitOid: "abc123",
    }),
  installDependencies: () => Effect.void,
  implement: () => Effect.succeed("ses_test"),
  assessChanges: () => Effect.void,
  preCommit: () => Effect.void,
  review: () => Effect.void,
  commit: () => Effect.void,
  createPr: () => Effect.succeed(101),
  watchPrStatusChecks: () => Effect.succeed("succeeded"),
  resolvePrMergeConflict: () => Effect.succeed({ _tag: "processed" }),
  investigatePrStatusChecks: () =>
    Effect.succeed({ _tag: "processed", handledCheckIds: [] }),
  markPrReadyForReview: () => Effect.void,
  decidePrMerge: () => Effect.succeed({ _tag: "clanker_merge" }),
  mergePr: () => Effect.void,
  localCleanup: () => Effect.void,
  removeWorktree: () => Effect.void,
}

const TestLayer = WorkItemLifecycleLive.pipe(
  Layer.provideMerge(
    Layer.succeed(LifecycleSteps, LifecycleSteps.of(successfulSteps)),
  ),
  Layer.provideMerge(DbServiceLive),
  Layer.provideMerge(SqliteQueueServiceLive),
  Layer.provideMerge(DatabaseTest),
)

const runTest = <A, E>(
  effect: Effect.Effect<A, E, Layer.Layer.Success<typeof TestLayer>>,
) => Effect.runPromise(Effect.provide(effect, TestLayer))

const seedRepository = (repositoryId: string, now: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(
      `INSERT INTO repository (
         id, github_owner, github_repo, local_path, is_bare, paused,
         issues_reconciled_at, created_at, updated_at
       ) VALUES (?, 'acme', ?, ?, 1, 0, NULL, ?, ?)`,
      [repositoryId, repositoryId, `/tmp/${repositoryId}`, now, now],
    )
  })

const seedWorkItemWithCommit = (input: {
  readonly workItemId: string
  readonly repositoryId: string
  readonly githubIssueNumber: number
  readonly githubPullRequestNumber: number | null
  readonly commitStatus: string
  readonly finishedAt: number | null
  readonly extraCommitFinishedAt?: number
  readonly now: number
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(
      `INSERT INTO work_item (
         id, repository_id, github_issue_number, github_pull_request_number,
         model, variant, review_model, review_variant, state, state_ready_at,
         worktree_path, session_id, failure_code, failure_message,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'm', 'v', 'm', 'v', 'complete', ?,
         NULL, NULL, NULL, NULL, ?, ?)`,
      [
        input.workItemId,
        input.repositoryId,
        input.githubIssueNumber,
        input.githubPullRequestNumber,
        input.now,
        input.now,
        input.now,
      ],
    )
    yield* sql.unsafe(
      `INSERT INTO step_run (
         id, work_item_id, step, status, queue_job_id, queued_at,
         started_at, finished_at, reason_code, reason_message,
         created_at, updated_at
       ) VALUES (?, ?, 'commit', ?, NULL, ?, ?, ?, NULL, NULL, ?, ?)`,
      [
        `${input.workItemId}-commit`,
        input.workItemId,
        input.commitStatus,
        input.now,
        input.finishedAt ?? input.now,
        input.finishedAt,
        input.now,
        input.now,
      ],
    )
    if (input.extraCommitFinishedAt !== undefined) {
      yield* sql.unsafe(
        `INSERT INTO step_run (
           id, work_item_id, step, status, queue_job_id, queued_at,
           started_at, finished_at, reason_code, reason_message,
           created_at, updated_at
         ) VALUES (?, ?, 'commit', 'succeeded', NULL, ?, ?, ?, NULL, NULL, ?, ?)`,
        [
          `${input.workItemId}-commit-retry`,
          input.workItemId,
          input.now,
          input.extraCommitFinishedAt,
          input.extraCommitFinishedAt,
          input.now,
          input.now,
        ],
      )
    }
  })

describe("countCommittedPullRequests", () => {
  const dayStart = Date.parse("2026-07-18T00:00:00.000Z")
  const dayEnd = Date.parse("2026-07-19T00:00:00.000Z")
  const yesterdayStart = Date.parse("2026-07-17T00:00:00.000Z")
  const midDay = Date.parse("2026-07-18T12:00:00.000Z")
  const justBeforeEnd = Date.parse("2026-07-18T23:59:59.999Z")
  const justAtEnd = dayEnd
  const now = midDay

  it("counts successful commit Step Runs with a PR number in [from, to)", () =>
    runTest(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        yield* seedRepository("repo-a", now)
        yield* seedRepository("repo-b", now)
        yield* seedWorkItemWithCommit({
          workItemId: "wi-today-a",
          repositoryId: "repo-a",
          githubIssueNumber: 1,
          githubPullRequestNumber: 10,
          commitStatus: "succeeded",
          finishedAt: midDay,
          now,
        })
        yield* seedWorkItemWithCommit({
          workItemId: "wi-today-b",
          repositoryId: "repo-b",
          githubIssueNumber: 2,
          githubPullRequestNumber: 20,
          commitStatus: "succeeded",
          finishedAt: justBeforeEnd,
          now,
        })

        expect(
          yield* lifecycle.countCommittedPullRequests(dayStart, dayEnd),
        ).toBe(2)
      }),
    ))

  it("returns 0 when nothing matches", () =>
    runTest(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        expect(
          yield* lifecycle.countCommittedPullRequests(dayStart, dayEnd),
        ).toBe(0)
      }),
    ))

  it("excludes failed and unfinished commit steps", () =>
    runTest(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        yield* seedRepository("repo-a", now)
        yield* seedWorkItemWithCommit({
          workItemId: "wi-failed",
          repositoryId: "repo-a",
          githubIssueNumber: 1,
          githubPullRequestNumber: 10,
          commitStatus: "failed",
          finishedAt: midDay,
          now,
        })
        yield* seedWorkItemWithCommit({
          workItemId: "wi-running",
          repositoryId: "repo-a",
          githubIssueNumber: 2,
          githubPullRequestNumber: 11,
          commitStatus: "running",
          finishedAt: null,
          now,
        })
        yield* seedWorkItemWithCommit({
          workItemId: "wi-queued",
          repositoryId: "repo-a",
          githubIssueNumber: 3,
          githubPullRequestNumber: 12,
          commitStatus: "queued",
          finishedAt: null,
          now,
        })

        expect(
          yield* lifecycle.countCommittedPullRequests(dayStart, dayEnd),
        ).toBe(0)
      }),
    ))

  it("excludes Work Items without a PR number", () =>
    runTest(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        yield* seedRepository("repo-a", now)
        yield* seedWorkItemWithCommit({
          workItemId: "wi-no-pr",
          repositoryId: "repo-a",
          githubIssueNumber: 1,
          githubPullRequestNumber: null,
          commitStatus: "succeeded",
          finishedAt: midDay,
          now,
        })

        expect(
          yield* lifecycle.countCommittedPullRequests(dayStart, dayEnd),
        ).toBe(0)
      }),
    ))

  it("counts each Work Item at most once per day even with retry commits", () =>
    runTest(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        yield* seedRepository("repo-a", now)
        yield* seedWorkItemWithCommit({
          workItemId: "wi-retry",
          repositoryId: "repo-a",
          githubIssueNumber: 1,
          githubPullRequestNumber: 10,
          commitStatus: "succeeded",
          finishedAt: Date.parse("2026-07-18T08:00:00.000Z"),
          extraCommitFinishedAt: Date.parse("2026-07-18T16:00:00.000Z"),
          now,
        })

        expect(
          yield* lifecycle.countCommittedPullRequests(dayStart, dayEnd),
        ).toBe(1)
      }),
    ))

  it("uses half-open [from, to) boundaries", () =>
    runTest(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        yield* seedRepository("repo-a", now)
        yield* seedWorkItemWithCommit({
          workItemId: "wi-start",
          repositoryId: "repo-a",
          githubIssueNumber: 1,
          githubPullRequestNumber: 10,
          commitStatus: "succeeded",
          finishedAt: dayStart,
          now,
        })
        yield* seedWorkItemWithCommit({
          workItemId: "wi-end",
          repositoryId: "repo-a",
          githubIssueNumber: 2,
          githubPullRequestNumber: 11,
          commitStatus: "succeeded",
          finishedAt: justAtEnd,
          now,
        })
        yield* seedWorkItemWithCommit({
          workItemId: "wi-yesterday",
          repositoryId: "repo-a",
          githubIssueNumber: 3,
          githubPullRequestNumber: 12,
          commitStatus: "succeeded",
          finishedAt: yesterdayStart,
          now,
        })

        expect(
          yield* lifecycle.countCommittedPullRequests(dayStart, dayEnd),
        ).toBe(1)
        expect(
          yield* lifecycle.countCommittedPullRequests(yesterdayStart, dayStart),
        ).toBe(1)
        expect(
          yield* lifecycle.countCommittedPullRequests(dayEnd, dayEnd + 1),
        ).toBe(1)
      }),
    ))
})
