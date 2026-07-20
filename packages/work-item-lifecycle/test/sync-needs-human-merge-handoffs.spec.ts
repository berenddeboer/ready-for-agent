import { Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import {
  GitHubService,
  type GitHubServiceShape,
  type PullRequestLifecycleStatus,
} from "@ready-for-agent/github-service"
import { QueueService } from "@ready-for-agent/queue-service"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
  LifecycleSteps,
  type LifecycleStepsShape,
  WORK_ITEM_LIFECYCLE_QUEUE,
  WorkItemLifecycle,
  WorkItemLifecycleLive,
  syncNeedsHumanMergeHandoffs,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("syncNeedsHumanMergeHandoffs", () => {
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
    review: () => Effect.void,
    commit: () => Effect.void,
    createPr: () => Effect.succeed(101),
    watchPrStatusChecks: () => Effect.succeed("succeeded"),
    resolvePrMergeConflict: () => Effect.succeed({ _tag: "processed" }),
    investigatePrStatusChecks: () =>
      Effect.succeed({ _tag: "processed", handledCheckIds: [] }),
    markPrReadyForReview: () => Effect.void,
    decidePrMerge: () =>
      Effect.succeed({
        _tag: "needs_human",
        reason: "Auto-merge is disabled for this repository",
      }),
    mergePr: () => Effect.die("merge must not run"),
    localCleanup: () => Effect.void,
    removeWorktree: () => Effect.void,
  }

  const githubWith = (status: PullRequestLifecycleStatus) =>
    Layer.succeed(GitHubService, {
      listReadyIssues: () => Effect.succeed([]),
      getOpenPullRequestNumber: () => Effect.succeed(1),
      getPullRequestCheckStatus: () =>
        Effect.succeed({
          _tag: "succeeded",
          terminalChecks: [],
          mergeability: "mergeable",
          baseRefName: "main",
          headPushedAt: null,
        }),
      getPrStatusCheckDiagnostics: () => Effect.succeed([]),
      getPullRequestLifecycleStatus: () => Effect.succeed(status),
      markPullRequestReadyForReview: () => Effect.void,
      mergePullRequest: () => Effect.succeed({ _tag: "merged" }),
      ensureIssueCompletedWithSummary: () => Effect.void,
    } satisfies GitHubServiceShape)

  const makeLayer = (
    status: PullRequestLifecycleStatus,
    steps: LifecycleStepsShape = successfulSteps,
  ) =>
    WorkItemLifecycleLive.pipe(
      Layer.provideMerge(
        Layer.succeed(LifecycleSteps, LifecycleSteps.of(steps)),
      ),
      Layer.provideMerge(DbServiceLive),
      Layer.provideMerge(SqliteQueueServiceLive),
      Layer.provideMerge(DatabaseTest),
      Layer.provideMerge(githubWith(status)),
    )

  const makeQueuedJobsAvailable = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(`UPDATE job_queue SET available_at = 0`)
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

  const driveToNeedsHuman = Effect.gen(function* () {
    const db = yield* DbService
    const lifecycle = yield* WorkItemLifecycle
    yield* db.updateConfig({
      defaultModel: "opencode/deepseek-v4-flash-free",
      defaultVariant: "low",
      reviewModel: null,
      reviewVariant: null,
      maxConcurrentOpencodeSessions: 2,
      maxConcurrentWorkItems: 5,
    })
    const repository = yield* db.addRepository({
      githubOwner: "acme",
      githubRepo: "widgets",
      localPath: "/repos/acme/widgets.git",
      isBare: true,
    })
    yield* db.storeIssue({
      repositoryId: repository.id,
      githubIssueNumber: 42,
      title: "Implement feature",
      body: "Issue body",
      url: "https://github.com/acme/widgets/issues/42",
      state: "OPEN",
      githubCreatedAt: new Date("2026-01-15T12:00:00.000Z"),
      parent: null,
      parentPosition: null,
      hasChildren: false,
      blockedBy: [],
    })
    const created = yield* lifecycle.implementNow(repository.id, 42)
    for (let index = 0; index < 12; index += 1) {
      yield* makeQueuedJobsAvailable
      yield* claimAndRunPending
    }
    const needsHuman = yield* lifecycle.getWorkItem(created.id)
    expect(needsHuman.state).toBe("needs_human")
    return { repository, created, lifecycle }
  })

  const driveToMergeNeedsHuman = Effect.gen(function* () {
    const db = yield* DbService
    const lifecycle = yield* WorkItemLifecycle
    yield* db.updateConfig({
      defaultModel: "opencode/deepseek-v4-flash-free",
      defaultVariant: "low",
      reviewModel: null,
      reviewVariant: null,
      maxConcurrentOpencodeSessions: 2,
      maxConcurrentWorkItems: 5,
    })
    const repository = yield* db.addRepository({
      githubOwner: "acme",
      githubRepo: "widgets",
      localPath: "/repos/acme/widgets.git",
      isBare: true,
    })
    yield* db.storeIssue({
      repositoryId: repository.id,
      githubIssueNumber: 42,
      title: "Implement feature",
      body: "Issue body",
      url: "https://github.com/acme/widgets/issues/42",
      state: "OPEN",
      githubCreatedAt: new Date("2026-01-15T12:00:00.000Z"),
      parent: null,
      parentPosition: null,
      hasChildren: false,
      blockedBy: [],
    })
    const created = yield* lifecycle.implementNow(repository.id, 42)
    for (let index = 0; index < 13; index += 1) {
      yield* makeQueuedJobsAvailable
      yield* claimAndRunPending
    }
    const needsHuman = yield* lifecycle.getWorkItem(created.id)
    expect(needsHuman.state).toBe("needs_human")
    expect(needsHuman.stepRuns.at(-1)?.step).toBe("merge_pr")
    return { repository, created, lifecycle }
  })

  it("resumes local cleanup when GitHub reports the PR merged", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { repository, created, lifecycle } = yield* driveToNeedsHuman
        const advanced = yield* syncNeedsHumanMergeHandoffs(repository.id)
        expect(advanced).toBe(1)
        const resumed = yield* lifecycle.getWorkItem(created.id)
        expect(resumed.state).toBe("local_cleanup")
        expect(resumed.failureCode).toBeNull()
      }).pipe(Effect.provide(makeLayer({ _tag: "merged" }))),
    )
  })

  it("leaves Needs Human alone when the PR is still open", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { repository, created, lifecycle } = yield* driveToNeedsHuman
        const advanced = yield* syncNeedsHumanMergeHandoffs(repository.id)
        expect(advanced).toBe(0)
        const still = yield* lifecycle.getWorkItem(created.id)
        expect(still.state).toBe("needs_human")
      }).pipe(Effect.provide(makeLayer({ _tag: "open" }))),
    )
  })

  it("abandons when GitHub reports the PR closed unmerged", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { repository, created, lifecycle } = yield* driveToNeedsHuman
        const advanced = yield* syncNeedsHumanMergeHandoffs(repository.id)
        expect(advanced).toBe(1)
        const abandoned = yield* lifecycle.getWorkItem(created.id)
        expect(abandoned.state).toBe("abandoned")
        expect(abandoned.worktreePath).toBeNull()
      }).pipe(Effect.provide(makeLayer({ _tag: "closed" }))),
    )
  })

  it("completes cleanup for a Merge PR Needs Human handoff after Refresh sees a merge", async () => {
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      decidePrMerge: () => Effect.succeed({ _tag: "clanker_merge" }),
      mergePr: () =>
        Effect.succeed({
          _tag: "needs_human",
          reason: "merge_rejected",
          message: "GitHub rejected the unchanged mergeable pull request",
        }),
    }
    await Effect.runPromise(
      Effect.gen(function* () {
        const { repository, created, lifecycle } = yield* driveToMergeNeedsHuman
        expect(yield* syncNeedsHumanMergeHandoffs(repository.id)).toBe(1)
        yield* makeQueuedJobsAvailable
        yield* claimAndRunPending
        expect((yield* lifecycle.getWorkItem(created.id)).state).toBe(
          "complete",
        )
      }).pipe(Effect.provide(makeLayer({ _tag: "merged" }, steps))),
    )
  })

  it("abandons a Merge PR Needs Human handoff after Refresh sees a close", async () => {
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      decidePrMerge: () => Effect.succeed({ _tag: "clanker_merge" }),
      mergePr: () =>
        Effect.succeed({
          _tag: "needs_human",
          reason: "closed_unmerged",
          message: "Pull request was concurrently closed",
        }),
    }
    await Effect.runPromise(
      Effect.gen(function* () {
        const { repository, created, lifecycle } = yield* driveToMergeNeedsHuman
        expect(yield* syncNeedsHumanMergeHandoffs(repository.id)).toBe(1)
        expect((yield* lifecycle.getWorkItem(created.id)).state).toBe(
          "abandoned",
        )
      }).pipe(Effect.provide(makeLayer({ _tag: "closed" }, steps))),
    )
  })
})
