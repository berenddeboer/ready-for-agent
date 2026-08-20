import { Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import {
  GitHubService,
  type GitHubServiceShape,
  GitHubThrottledError,
  type PullRequestCheckStatus,
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
  stubActiveAgentBackendLayer,
  stubAzureDevOpsServiceLayer,
  stubGitLabServiceLayer,
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
    review: () => Effect.succeed({ _tag: "clean" as const }),
    commit: () =>
      Effect.succeed({
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
        // Already-ready snapshot: Watch advances past deadline to Decide.
        isDraft: false,
      }),
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

  type Mergeability = "mergeable" | "conflicting" | "unknown"
  type CheckStatusTag = "succeeded" | "closed"
  type GitHubLookupOverrides = {
    readonly checkStatus?: () => Effect.Effect<
      PullRequestCheckStatus,
      GitHubThrottledError
    >
    readonly lifecycleStatus?: () => Effect.Effect<
      PullRequestLifecycleStatus,
      GitHubThrottledError
    >
  }

  const githubWith = (
    getStatus: () => PullRequestLifecycleStatus,
    getMergeability: () => Mergeability = () => "mergeable",
    getCheckStatusTag: () => CheckStatusTag = () => "succeeded",
    overrides: GitHubLookupOverrides = {},
  ) =>
    Layer.succeed(GitHubService, {
      getAuthenticatedUserLogin: () => Effect.succeed("test-operator"),
      listReadyIssues: () => Effect.succeed([]),
      getOpenPullRequestNumber: () => Effect.succeed(1),
      findOpenPullRequestNumber: () => Effect.succeed(1),
      createDraftPullRequest: () => Effect.succeed(1),
      countOpenNonDraftPullRequests: () => Effect.succeed(0),
      getPullRequestCheckStatus: () =>
        overrides.checkStatus?.() ??
        Effect.succeed(
          getCheckStatusTag() === "closed"
            ? {
                _tag: "closed" as const,
                mergeability: getMergeability(),
                baseRefName: "main",
                headPushedAt: null,
                headSha: null,
                createdAt: null,
                isDraft: null,
              }
            : {
                _tag: "succeeded" as const,
                terminalChecks: [],
                mergeability: getMergeability(),
                baseRefName: "main",
                headPushedAt: null,
                headSha: null,
                createdAt: null,
                isDraft: null,
              },
        ),
      getPrStatusCheckDiagnostics: () => Effect.succeed([]),
      observeAutomatedReviewEvidence: () =>
        Effect.succeed({
          _tag: "ambiguous" as const,
          reason: "Automated review evidence observation is not configured",
        }),
      getPullRequestLifecycleStatus: () =>
        overrides.lifecycleStatus?.() ?? Effect.succeed(getStatus()),
      markPullRequestReadyForReview: () => Effect.void,
      mergePullRequest: () => Effect.succeed({ _tag: "merged" }),
      rerunWorkflowRun: () => Effect.void,
      uploadUserAttachment: () =>
        Effect.succeed(
          "https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000001",
        ),
      ensureIssueCompletedWithSummary: () => Effect.void,
    } satisfies GitHubServiceShape)

  const makeLayer = (
    status: PullRequestLifecycleStatus,
    steps: LifecycleStepsShape = successfulSteps,
    mergeability: Mergeability = "mergeable",
    checkStatusTag: CheckStatusTag = "succeeded",
  ) =>
    makeLayerWithStatus(
      () => status,
      steps,
      {},
      () => mergeability,
      () => checkStatusTag,
    )

  const makeLayerWithStatus = (
    getStatus: () => PullRequestLifecycleStatus,
    steps: LifecycleStepsShape = successfulSteps,
    gitlab: Parameters<typeof stubGitLabServiceLayer>[0] = {},
    getMergeability: () => Mergeability = () => "mergeable",
    getCheckStatusTag: () => CheckStatusTag = () => "succeeded",
    githubLookupOverrides: GitHubLookupOverrides = {},
  ) =>
    WorkItemLifecycleLive.pipe(
      Layer.provideMerge(stubActiveAgentBackendLayer()),
      // githubWith controls GitHub PR lifecycle for syncNeedsHumanMergeHandoffs.
      Layer.provideMerge(
        githubWith(
          getStatus,
          getMergeability,
          getCheckStatusTag,
          githubLookupOverrides,
        ),
      ),
      Layer.provideMerge(stubGitLabServiceLayer(gitlab)),
      Layer.provideMerge(stubAzureDevOpsServiceLayer()),
      Layer.provideMerge(
        Layer.succeed(LifecycleSteps, LifecycleSteps.of(steps)),
      ),
      Layer.provideMerge(DbServiceLive),
      Layer.provideMerge(SqliteQueueServiceLive),
      Layer.provideMerge(DatabaseTest),
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

  const driveToNeedsHuman = (forge: "github" | "gitlab" = "github") =>
    Effect.gen(function* () {
      const db = yield* DbService
      const lifecycle = yield* WorkItemLifecycle
      yield* db.updateConfig({
        selectedAgentBackend: "opencode",
        defaultModel: "opencode/deepseek-v4-flash-free",
        defaultThinkingLevel: "low",
        reviewModel: null,
        reviewThinkingLevel: null,
        maxConcurrentAgentTurns: 2,
        maxConcurrentWorkItems: 5,
      })
      const repository = yield* db.addRepository({
        forge,
        forgeHost: forge === "github" ? "github.com" : "git.drupalcode.org",
        projectPath: "acme/widgets",
        localPath: "/repos/acme/widgets.git",
        isBare: true,
      })
      yield* db.storeIssue({
        repositoryId: repository.id,
        issueNumber: 42,
        title: "Implement feature",
        body: "Issue body",
        url:
          forge === "github"
            ? "https://github.com/acme/widgets/issues/42"
            : "https://git.drupalcode.org/acme/widgets/-/issues/42",
        state: "OPEN",
        githubCreatedAt: new Date("2026-01-15T12:00:00.000Z"),
        issueAuthor: null,
        parent: null,
        parentPosition: null,
        hasChildren: false,
        blockedBy: [],
      })
      const created = yield* lifecycle.implementNow(repository.id, 42)
      for (let index = 0; index < 8; index += 1) {
        yield* makeQueuedJobsAvailable
        yield* claimAndRunPending
      }
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe(
        `UPDATE work_item SET check_start_last_observed_is_draft = NULL WHERE id = ?`,
        [created.id],
      )
      for (let index = 0; index < 2; index += 1) {
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
      selectedAgentBackend: "opencode",
      defaultModel: "opencode/deepseek-v4-flash-free",
      defaultThinkingLevel: "low",
      reviewModel: null,
      reviewThinkingLevel: null,
      maxConcurrentAgentTurns: 2,
      maxConcurrentWorkItems: 5,
    })
    const repository = yield* db.addRepository({
      forge: "github",
      forgeHost: "github.com",
      projectPath: "acme/widgets",
      localPath: "/repos/acme/widgets.git",
      isBare: true,
    })
    yield* db.storeIssue({
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
    const created = yield* lifecycle.implementNow(repository.id, 42)
    for (let index = 0; index < 8; index += 1) {
      yield* makeQueuedJobsAvailable
      yield* claimAndRunPending
    }
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(
      `UPDATE work_item SET check_start_last_observed_is_draft = NULL WHERE id = ?`,
      [created.id],
    )
    for (let index = 0; index < 3; index += 1) {
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
        const { repository, created, lifecycle } = yield* driveToNeedsHuman()
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
        const { repository, created, lifecycle } = yield* driveToNeedsHuman()
        const advanced = yield* syncNeedsHumanMergeHandoffs(repository.id)
        expect(advanced).toBe(0)
        const still = yield* lifecycle.getWorkItem(created.id)
        expect(still.state).toBe("needs_human")
      }).pipe(Effect.provide(makeLayer({ _tag: "open" }))),
    )
  })

  it("propagates GitHub throttling from PR lifecycle observation", async () => {
    const throttle = new GitHubThrottledError({
      retryAt: 1_750_000_000_000,
      usedFallback: false,
    })
    let throttled = false

    await Effect.runPromise(
      Effect.gen(function* () {
        const { repository } = yield* driveToNeedsHuman()
        throttled = true
        const error = yield* syncNeedsHumanMergeHandoffs(repository.id).pipe(
          Effect.flip,
        )
        expect(error).toBe(throttle)
      }).pipe(
        Effect.provide(
          makeLayerWithStatus(
            () => ({ _tag: "open" }),
            successfulSteps,
            {},
            () => "mergeable",
            () => "succeeded",
            {
              lifecycleStatus: () =>
                throttled
                  ? Effect.fail(throttle)
                  : Effect.succeed({ _tag: "open" }),
            },
          ),
        ),
      ),
    )
  })

  it("propagates GitHub throttling from mergeability observation", async () => {
    const throttle = new GitHubThrottledError({
      retryAt: 1_750_000_000_000,
      usedFallback: false,
    })
    let throttled = false

    await Effect.runPromise(
      Effect.gen(function* () {
        const { repository } = yield* driveToNeedsHuman()
        throttled = true
        const error = yield* syncNeedsHumanMergeHandoffs(repository.id).pipe(
          Effect.flip,
        )
        expect(error).toBe(throttle)
      }).pipe(
        Effect.provide(
          makeLayerWithStatus(
            () => ({ _tag: "open" }),
            successfulSteps,
            {},
            () => "mergeable",
            () => "succeeded",
            {
              checkStatus: () =>
                throttled
                  ? Effect.fail(throttle)
                  : Effect.succeed({
                      _tag: "succeeded",
                      terminalChecks: [],
                      mergeability: "mergeable",
                      baseRefName: "main",
                      headPushedAt: null,
                      headSha: null,
                      createdAt: null,
                      isDraft: null,
                    }),
            },
          ),
        ),
      ),
    )
  })

  it("abandons when GitHub reports the PR closed unmerged", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { repository, created, lifecycle } = yield* driveToNeedsHuman()
        const advanced = yield* syncNeedsHumanMergeHandoffs(repository.id)
        expect(advanced).toBe(1)
        const abandoned = yield* lifecycle.getWorkItem(created.id)
        expect(abandoned.state).toBe("abandoned")
        expect(abandoned.worktreePath).toBeNull()
      }).pipe(Effect.provide(makeLayer({ _tag: "closed" }))),
    )
  })

  it("uses GitLab PR lifecycle for persisted GitLab Work Items", async () => {
    let githubCalls = 0
    let gitlabCalls = 0
    await Effect.runPromise(
      Effect.gen(function* () {
        const { repository, created, lifecycle } =
          yield* driveToNeedsHuman("gitlab")
        expect(
          (yield* lifecycle.getWorkItem(created.id)).pullRequestNumber,
        ).toBe(101)

        expect(yield* syncNeedsHumanMergeHandoffs(repository.id)).toBe(1)
        const resumed = yield* lifecycle.getWorkItem(created.id)
        expect(resumed.state).toBe("local_cleanup")
        expect(githubCalls).toBe(0)
        expect(gitlabCalls).toBeGreaterThan(0)
      }).pipe(
        Effect.provide(
          makeLayerWithStatus(
            () => {
              githubCalls += 1
              return { _tag: "merged" }
            },
            successfulSteps,
            {
              getPullRequestLifecycleStatus: () => {
                gitlabCalls += 1
                return Effect.succeed({ _tag: "merged" })
              },
            },
          ),
        ),
      ),
    )
  })

  it("abandons GitLab merge-related Needs Human when the MR is closed unmerged", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { repository, created, lifecycle } =
          yield* driveToNeedsHuman("gitlab")
        expect(yield* syncNeedsHumanMergeHandoffs(repository.id)).toBe(1)
        const abandoned = yield* lifecycle.getWorkItem(created.id)
        expect(abandoned.state).toBe("abandoned")
        expect(abandoned.worktreePath).toBeNull()
      }).pipe(
        Effect.provide(
          makeLayerWithStatus(() => ({ _tag: "open" }), successfulSteps, {
            getPullRequestLifecycleStatus: () =>
              Effect.succeed({ _tag: "closed" }),
          }),
        ),
      ),
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

  const driveToWatchPrStatusChecks = Effect.gen(function* () {
    const db = yield* DbService
    const lifecycle = yield* WorkItemLifecycle
    yield* db.updateConfig({
      selectedAgentBackend: "opencode",
      defaultModel: "opencode/deepseek-v4-flash-free",
      defaultThinkingLevel: "low",
      reviewModel: null,
      reviewThinkingLevel: null,
      maxConcurrentAgentTurns: 2,
      maxConcurrentWorkItems: 5,
    })
    const repository = yield* db.addRepository({
      forge: "github",
      forgeHost: "github.com",
      projectPath: "acme/widgets",
      localPath: "/repos/acme/widgets.git",
      isBare: true,
    })
    yield* db.storeIssue({
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
    const created = yield* lifecycle.implementNow(repository.id, 42)
    for (let index = 0; index < 8; index += 1) {
      yield* makeQueuedJobsAvailable
      yield* claimAndRunPending
    }
    const watching = yield* lifecycle.getWorkItem(created.id)
    expect(watching.state).toBe("watch_pr_status_checks")
    expect(watching.pullRequestNumber).toBe(101)
    return { repository, created, lifecycle }
  })

  it("advances a Watch PR Status Checks Work Item to local cleanup when Refresh sees a merge", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { repository, created, lifecycle } =
          yield* driveToWatchPrStatusChecks
        expect(yield* syncNeedsHumanMergeHandoffs(repository.id)).toBe(1)
        const advanced = yield* lifecycle.getWorkItem(created.id)
        expect(advanced.state).toBe("local_cleanup")
        expect(advanced.failureCode).toBeNull()
        const cancelledWatch = advanced.stepRuns.find(
          (run) =>
            run.step === "watch_pr_status_checks" && run.status === "cancelled",
        )
        expect(cancelledWatch).toBeDefined()
        expect(cancelledWatch?.reasonCode).toBe("pr_merged")
      }).pipe(Effect.provide(makeLayer({ _tag: "merged" }))),
    )
  })

  it("does not abandon operational steps when the PR is only closed unmerged", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { repository, created, lifecycle } =
          yield* driveToWatchPrStatusChecks
        expect(yield* syncNeedsHumanMergeHandoffs(repository.id)).toBe(0)
        const still = yield* lifecycle.getWorkItem(created.id)
        expect(still.state).toBe("watch_pr_status_checks")
      }).pipe(Effect.provide(makeLayer({ _tag: "closed" }))),
    )
  })

  it("completes cleanup after Refresh sees a merge during status-check investigation (restart regression)", async () => {
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      watchPrStatusChecks: () =>
        Effect.succeed({
          _tag: "handoff_needed" as const,
          createdAt: new Date(0),
          headSha: "settled-head",
          headPushedAt: new Date(0),
          isDraft: false,
        }),
      investigatePrStatusChecks: () =>
        Effect.succeed({ _tag: "processed", handledCheckIds: [] }),
    }
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const queue = yield* QueueService
        yield* db.updateConfig({
          selectedAgentBackend: "opencode",
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultThinkingLevel: "low",
          reviewModel: null,
          reviewThinkingLevel: null,
          maxConcurrentAgentTurns: 2,
          maxConcurrentWorkItems: 5,
        })
        const repository = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets.git",
          isBare: true,
        })
        yield* db.storeIssue({
          repositoryId: repository.id,
          issueNumber: 2116,
          title: "Status check investigation",
          body: "Issue body",
          url: "https://github.com/acme/widgets/issues/2116",
          state: "OPEN",
          githubCreatedAt: new Date("2026-01-15T12:00:00.000Z"),
          issueAuthor: null,
          parent: null,
          parentPosition: null,
          hasChildren: false,
          blockedBy: [],
        })
        const created = yield* lifecycle.implementNow(repository.id, 2116)
        for (let index = 0; index < 8; index += 1) {
          yield* makeQueuedJobsAvailable
          yield* claimAndRunPending
        }
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(
          `UPDATE work_item SET check_start_last_observed_is_draft = NULL WHERE id = ?`,
          [created.id],
        )
        yield* makeQueuedJobsAvailable
        yield* claimAndRunPending
        const investigating = yield* lifecycle.getWorkItem(created.id)
        expect(investigating.state).toBe("investigate_pr_status_checks")

        // Simulate prior-process interrupt (harness restart) without requeue:
        // cancel the queued investigation the way startup would leave durable
        // state after interrupting a still-running delivery, or after a
        // worker_restarted mark with no automatic redelivery.
        const queuedInvestigate = investigating.stepRuns.find(
          (run) =>
            run.step === "investigate_pr_status_checks" &&
            run.status === "queued",
        )
        expect(queuedInvestigate).toBeDefined()
        yield* sql.unsafe(
          `UPDATE step_run
           SET status = 'interrupted',
               finished_at = ?,
               reason_code = 'worker_restarted',
               reason_message = 'Harness restarted',
               updated_at = ?
           WHERE id = ?`,
          [Date.now(), Date.now(), queuedInvestigate!.id],
        )
        if (queuedInvestigate!.queueJobId !== null) {
          yield* queue
            .acknowledge(queuedInvestigate!.queueJobId)
            .pipe(Effect.catch(() => Effect.void))
        }
        yield* sql.unsafe(
          `UPDATE work_item SET holds_worker_slot = 0, waiting_since = NULL WHERE id = ?`,
          [created.id],
        )

        // Issue closed/removed by the merge — must not produce Failed.
        yield* db.deleteIssue(repository.id, 2116)

        expect(yield* syncNeedsHumanMergeHandoffs(repository.id)).toBe(1)
        const advanced = yield* lifecycle.getWorkItem(created.id)
        expect(advanced.state).toBe("local_cleanup")
        expect(advanced.failureCode).toBeNull()

        yield* makeQueuedJobsAvailable
        yield* claimAndRunPending
        const completed = yield* lifecycle.getWorkItem(created.id)
        expect(completed.state).toBe("complete")
        expect(completed.worktreePath).toBeNull()
        expect(
          completed.stepRuns.some(
            (run) =>
              run.step === "investigate_pr_status_checks" &&
              run.status === "queued",
          ),
        ).toBe(false)
      }).pipe(Effect.provide(makeLayer({ _tag: "merged" }, steps))),
    )
  })

  it("completes cleanup via Refresh after external merge of a Work Item paused for closed Issue + open PR", async () => {
    let prStatus: PullRequestLifecycleStatus = { _tag: "open" }
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      watchPrStatusChecks: () =>
        Effect.succeed({
          _tag: "handoff_needed" as const,
          createdAt: new Date(0),
          headSha: "settled-head",
          headPushedAt: new Date(0),
          isDraft: false,
        }),
      investigatePrStatusChecks: () =>
        Effect.succeed({ _tag: "processed", handledCheckIds: [] }),
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const queue = yield* QueueService
        yield* db.updateConfig({
          selectedAgentBackend: "opencode",
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultThinkingLevel: "low",
          reviewModel: null,
          reviewThinkingLevel: null,
          maxConcurrentAgentTurns: 2,
          maxConcurrentWorkItems: 5,
        })
        const repository = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets.git",
          isBare: true,
        })
        yield* db.storeIssue({
          repositoryId: repository.id,
          issueNumber: 532,
          title: "Paused then externally merged",
          body: "Issue body",
          url: "https://github.com/acme/widgets/issues/532",
          state: "OPEN",
          githubCreatedAt: new Date("2026-01-15T12:00:00.000Z"),
          issueAuthor: null,
          parent: null,
          parentPosition: null,
          hasChildren: false,
          blockedBy: [],
        })
        const created = yield* lifecycle.implementNow(repository.id, 532)
        for (let index = 0; index < 8; index += 1) {
          yield* makeQueuedJobsAvailable
          yield* claimAndRunPending
        }
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(
          `UPDATE work_item SET check_start_last_observed_is_draft = NULL WHERE id = ?`,
          [created.id],
        )
        yield* makeQueuedJobsAvailable
        yield* claimAndRunPending
        expect((yield* lifecycle.getWorkItem(created.id)).state).toBe(
          "investigate_pr_status_checks",
        )

        // Open-PR pause setup from the closed-Issue path (#529).
        prStatus = { _tag: "open" }
        yield* db.deleteIssue(repository.id, 532)
        yield* makeQueuedJobsAvailable
        const afterInvestigate = yield* claimAndRunPending
        expect(afterInvestigate._tag).toBe("processed")
        if (afterInvestigate._tag !== "processed") return
        expect(afterInvestigate.workItem.paused).toBe(true)
        expect(afterInvestigate.workItem.holdsWorkerSlot).toBe(false)
        expect(afterInvestigate.workItem.failureMessage).toContain("still open")
        expect(
          Option.isNone(yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)),
        ).toBe(true)

        // External merge later; Refresh must supersede pause → cleanup → Complete.
        prStatus = { _tag: "merged" }
        expect(yield* syncNeedsHumanMergeHandoffs(repository.id)).toBe(1)
        const advanced = yield* lifecycle.getWorkItem(created.id)
        expect(advanced.state).toBe("local_cleanup")
        expect(advanced.paused).toBe(false)
        expect(advanced.failureCode).toBeNull()
        expect(advanced.failureMessage).toBeNull()
        expect(advanced.holdsWorkerSlot).toBe(true)
        expect(advanced.waitingSince).toBeNull()

        yield* makeQueuedJobsAvailable
        yield* claimAndRunPending
        const completed = yield* lifecycle.getWorkItem(created.id)
        expect(completed.state).toBe("complete")
        expect(completed.paused).toBe(false)
        expect(completed.failureMessage).toBeNull()
        expect(completed.holdsWorkerSlot).toBe(false)
        expect(completed.worktreePath).toBeNull()
      }).pipe(Effect.provide(makeLayerWithStatus(() => prStatus, steps))),
    )
  })

  const resolveNeedsHumanSteps: LifecycleStepsShape = {
    ...successfulSteps,
    watchPrStatusChecks: () =>
      Effect.succeed({
        _tag: "conflict" as const,
        retiredCheckIds: [],
        createdAt: new Date(0),
        headSha: "conflict-head",
        headPushedAt: new Date(0),
        isDraft: false,
      }),
    resolvePrMergeConflict: () =>
      Effect.succeed({
        _tag: "needs_human",
        reason: "Merge conflict requires human resolution",
      }),
  }

  const driveToResolveNeedsHuman = Effect.gen(function* () {
    const db = yield* DbService
    const lifecycle = yield* WorkItemLifecycle
    yield* db.updateConfig({
      selectedAgentBackend: "opencode",
      defaultModel: "opencode/deepseek-v4-flash-free",
      defaultThinkingLevel: "low",
      reviewModel: null,
      reviewThinkingLevel: null,
      maxConcurrentAgentTurns: 2,
      maxConcurrentWorkItems: 5,
    })
    const repository = yield* db.addRepository({
      forge: "github",
      forgeHost: "github.com",
      projectPath: "acme/widgets",
      localPath: "/repos/acme/widgets.git",
      isBare: true,
    })
    yield* db.storeIssue({
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
    const created = yield* lifecycle.implementNow(repository.id, 42)
    // create…create_pr (8) + watch→resolve + resolve→needs_human
    for (let index = 0; index < 10; index += 1) {
      yield* makeQueuedJobsAvailable
      yield* claimAndRunPending
    }
    const needsHuman = yield* lifecycle.getWorkItem(created.id)
    expect(needsHuman.state).toBe("needs_human")
    expect(needsHuman.stepRuns.at(-1)?.step).toBe("resolve_pr_merge_conflict")
    return { repository, created, lifecycle }
  })

  it("advances Decide Needs Human to Resolve when Refresh sees a conflicting open PR", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { repository, created, lifecycle } = yield* driveToNeedsHuman()
        expect(yield* syncNeedsHumanMergeHandoffs(repository.id)).toBe(1)
        const advanced = yield* lifecycle.getWorkItem(created.id)
        expect(advanced.state).toBe("resolve_pr_merge_conflict")
        expect(advanced.failureCode).toBeNull()
        expect(advanced.failureMessage).toBeNull()
        expect(advanced.holdsWorkerSlot).toBe(true)
        expect(
          advanced.stepRuns.some(
            (run) =>
              run.step === "resolve_pr_merge_conflict" &&
              run.status === "queued",
          ),
        ).toBe(true)
      }).pipe(
        Effect.provide(
          makeLayer({ _tag: "open" }, successfulSteps, "conflicting"),
        ),
      ),
    )
  })

  it("advances Merge Needs Human to Resolve when Refresh sees a conflicting open PR", async () => {
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
        const advanced = yield* lifecycle.getWorkItem(created.id)
        expect(advanced.state).toBe("resolve_pr_merge_conflict")
        expect(advanced.holdsWorkerSlot).toBe(true)
      }).pipe(
        Effect.provide(makeLayer({ _tag: "open" }, steps, "conflicting")),
      ),
    )
  })

  it("advances Resolve Needs Human to Watch when Refresh sees mergeability recovered", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { repository, created, lifecycle } =
          yield* driveToResolveNeedsHuman
        expect(yield* syncNeedsHumanMergeHandoffs(repository.id)).toBe(1)
        const advanced = yield* lifecycle.getWorkItem(created.id)
        expect(advanced.state).toBe("watch_pr_status_checks")
        expect(advanced.failureCode).toBeNull()
        expect(advanced.holdsWorkerSlot).toBe(true)
        expect(
          advanced.stepRuns.some(
            (run) =>
              run.step === "watch_pr_status_checks" && run.status === "queued",
          ),
        ).toBe(true)
      }).pipe(
        Effect.provide(
          makeLayer({ _tag: "open" }, resolveNeedsHumanSteps, "mergeable"),
        ),
      ),
    )
  })

  it("leaves Resolve Needs Human parked when the open PR is still conflicting", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { repository, created, lifecycle } =
          yield* driveToResolveNeedsHuman
        expect(yield* syncNeedsHumanMergeHandoffs(repository.id)).toBe(0)
        const still = yield* lifecycle.getWorkItem(created.id)
        expect(still.state).toBe("needs_human")
        expect(still.stepRuns.at(-1)?.step).toBe("resolve_pr_merge_conflict")
      }).pipe(
        Effect.provide(
          makeLayer({ _tag: "open" }, resolveNeedsHumanSteps, "conflicting"),
        ),
      ),
    )
  })

  it("does not transition Needs Human when mergeability is unknown", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { repository, created, lifecycle } = yield* driveToNeedsHuman()
        expect(yield* syncNeedsHumanMergeHandoffs(repository.id)).toBe(0)
        const still = yield* lifecycle.getWorkItem(created.id)
        expect(still.state).toBe("needs_human")
        expect(still.stepRuns.at(-1)?.step).toBe("decide_pr_merge")
      }).pipe(
        Effect.provide(makeLayer({ _tag: "open" }, successfulSteps, "unknown")),
      ),
    )
  })

  it("does not advance Resolve Needs Human when check-status reports closed after lifecycle open (TOCTOU)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { repository, created, lifecycle } =
          yield* driveToResolveNeedsHuman
        // Lifecycle still open; check-status already closed+mergeable must not
        // clear to Watch (would leave non-abandonable watch Needs Human).
        expect(yield* syncNeedsHumanMergeHandoffs(repository.id)).toBe(0)
        const still = yield* lifecycle.getWorkItem(created.id)
        expect(still.state).toBe("needs_human")
        expect(still.stepRuns.at(-1)?.step).toBe("resolve_pr_merge_conflict")
      }).pipe(
        Effect.provide(
          makeLayer(
            { _tag: "open" },
            resolveNeedsHumanSteps,
            "mergeable",
            "closed",
          ),
        ),
      ),
    )
  })

  it("abandons Resolve Needs Human when Refresh sees the PR closed unmerged", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { repository, created, lifecycle } =
          yield* driveToResolveNeedsHuman
        expect(yield* syncNeedsHumanMergeHandoffs(repository.id)).toBe(1)
        const abandoned = yield* lifecycle.getWorkItem(created.id)
        expect(abandoned.state).toBe("abandoned")
        expect(abandoned.worktreePath).toBeNull()
      }).pipe(
        Effect.provide(
          makeLayer({ _tag: "closed" }, resolveNeedsHumanSteps, "conflicting"),
        ),
      ),
    )
  })

  it("merged still supersedes Resolve Needs Human", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { repository, created, lifecycle } =
          yield* driveToResolveNeedsHuman
        expect(yield* syncNeedsHumanMergeHandoffs(repository.id)).toBe(1)
        const advanced = yield* lifecycle.getWorkItem(created.id)
        expect(advanced.state).toBe("local_cleanup")
        expect(advanced.failureCode).toBeNull()
      }).pipe(
        Effect.provide(
          makeLayer({ _tag: "merged" }, resolveNeedsHumanSteps, "conflicting"),
        ),
      ),
    )
  })

  it("does not auto-Start a paused closed-Issue Work Item when Refresh sees the Issue open again without merge", async () => {
    let prStatus: PullRequestLifecycleStatus = { _tag: "open" }
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      watchPrStatusChecks: () =>
        Effect.succeed({
          _tag: "handoff_needed" as const,
          createdAt: new Date(0),
          headSha: "settled-head",
          headPushedAt: new Date(0),
          isDraft: false,
        }),
      investigatePrStatusChecks: () =>
        Effect.succeed({ _tag: "processed", handledCheckIds: [] }),
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const queue = yield* QueueService
        yield* db.updateConfig({
          selectedAgentBackend: "opencode",
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultThinkingLevel: "low",
          reviewModel: null,
          reviewThinkingLevel: null,
          maxConcurrentAgentTurns: 2,
          maxConcurrentWorkItems: 5,
        })
        const repository = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets.git",
          isBare: true,
        })
        yield* db.storeIssue({
          repositoryId: repository.id,
          issueNumber: 532,
          title: "Paused until operator Start",
          body: "Issue body",
          url: "https://github.com/acme/widgets/issues/532",
          state: "OPEN",
          githubCreatedAt: new Date("2026-01-15T12:00:00.000Z"),
          issueAuthor: null,
          parent: null,
          parentPosition: null,
          hasChildren: false,
          blockedBy: [],
        })
        const created = yield* lifecycle.implementNow(repository.id, 532)
        for (let index = 0; index < 8; index += 1) {
          yield* makeQueuedJobsAvailable
          yield* claimAndRunPending
        }
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(
          `UPDATE work_item SET check_start_last_observed_is_draft = NULL WHERE id = ?`,
          [created.id],
        )
        yield* makeQueuedJobsAvailable
        yield* claimAndRunPending

        prStatus = { _tag: "open" }
        yield* db.deleteIssue(repository.id, 532)
        yield* makeQueuedJobsAvailable
        const paused = yield* claimAndRunPending
        expect(paused._tag).toBe("processed")
        if (paused._tag !== "processed") return
        expect(paused.workItem.paused).toBe(true)
        const pauseReason = paused.workItem.failureMessage
        const stepRunCount = paused.workItem.stepRuns.length

        // Reconciliation restores the open Issue; PR remains open.
        yield* db.storeIssue({
          repositoryId: repository.id,
          issueNumber: 532,
          title: "Paused until operator Start",
          body: "Issue body",
          url: "https://github.com/acme/widgets/issues/532",
          state: "OPEN",
          githubCreatedAt: new Date("2026-01-15T12:00:00.000Z"),
          issueAuthor: null,
          parent: null,
          parentPosition: null,
          hasChildren: false,
          blockedBy: [],
        })
        prStatus = { _tag: "open" }
        expect(yield* syncNeedsHumanMergeHandoffs(repository.id)).toBe(0)
        expect(yield* lifecycle.releaseWaitingForBlockers(repository.id)).toBe(
          0,
        )

        const still = yield* lifecycle.getWorkItem(created.id)
        expect(still.paused).toBe(true)
        expect(still.failureMessage).toBe(pauseReason)
        expect(still.state).toBe("investigate_pr_status_checks")
        expect(still.holdsWorkerSlot).toBe(false)
        expect(still.stepRuns).toHaveLength(stepRunCount)
        expect(
          Option.isNone(yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)),
        ).toBe(true)
      }).pipe(Effect.provide(makeLayerWithStatus(() => prStatus, steps))),
    )
  })
})
