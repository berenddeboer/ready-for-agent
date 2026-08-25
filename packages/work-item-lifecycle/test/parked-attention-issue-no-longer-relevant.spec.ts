import { Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import { QueueService } from "@ready-for-agent/queue-service"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
  AUTO_MERGE_DISABLED_FOR_REPOSITORY,
  LifecycleStepFailedError,
  LifecycleSteps,
  type LifecycleStepsShape,
  RetryNotEligibleError,
  STEP_RUN_REASON,
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

describe("parked Attention when the Issue is no longer Relevant", () => {
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
        isDraft: false,
      }),
    resolvePrMergeConflict: () => Effect.succeed({ _tag: "processed" }),
    investigatePrStatusChecks: () =>
      Effect.succeed({ _tag: "processed", handledCheckIds: [] }),
    markPrReadyForReview: () =>
      Effect.succeed({ completion: "native" as const }),
    decidePrMerge: () => Effect.succeed({ _tag: "clanker_merge" }),
    mergePr: () => Effect.succeed({ _tag: "merged" }),
    closeIssue: () => Effect.void,
    localCleanup: () => Effect.void,
    removeWorktree: () => Effect.void,
  }

  const makeLayer = (
    steps: LifecycleStepsShape = successfulSteps,
    github: Parameters<typeof stubGitHubServiceLayer>[0] = {},
  ) =>
    WorkItemLifecycleLive.pipe(
      Layer.provideMerge(stubActiveAgentBackendLayer()),
      Layer.provideMerge(stubGitHubServiceLayer(github)),
      Layer.provideMerge(stubGitLabServiceLayer()),
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

  const seedIssue = (input: {
    readonly forge?: "github" | "gitlab" | "azure-devops"
    readonly projectPath?: string
    readonly issueNumber?: number
  }) =>
    Effect.gen(function* () {
      const db = yield* DbService
      yield* seedHarnessBuildModel
      const forge = input.forge ?? "github"
      const projectPath = input.projectPath ?? "acme/widgets"
      const issueNumber = input.issueNumber ?? 42
      const repository = yield* db.addRepository({
        forge,
        forgeHost:
          forge === "gitlab"
            ? "git.drupalcode.org"
            : forge === "azure-devops"
              ? "dev.azure.com"
              : "github.com",
        projectPath,
        localPath: `/repos/${projectPath}.git`,
        isBare: true,
      })
      const issue = yield* db.storeIssue({
        repositoryId: repository.id,
        issueNumber,
        title: "Implement feature",
        body: "Issue body",
        url: `https://example.test/${projectPath}/issues/${String(issueNumber)}`,
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

  const driveToFailedCommit = Effect.gen(function* () {
    const lifecycle = yield* WorkItemLifecycle
    const { repository, issue } = yield* seedIssue({})
    const created = yield* lifecycle.implementNow(
      repository.id,
      issue.issueNumber,
    )
    for (let index = 0; index < 7; index += 1) {
      yield* makeQueuedJobsAvailable
      yield* claimAndRunPending
    }
    const failed = yield* lifecycle.getWorkItem(created.id)
    expect(failed.state).toBe("commit")
    expect(failed.pullRequestNumber).toBeNull()
    expect(failed.stepRuns.at(-1)?.status).toBe("failed")
    return { repository, created: failed, lifecycle }
  })

  const driveToPausedCommit = Effect.gen(function* () {
    const lifecycle = yield* WorkItemLifecycle
    const { repository, issue } = yield* seedIssue({
      projectPath: "acme/paused-commit",
    })
    const created = yield* lifecycle.implementLocally(
      repository.id,
      issue.issueNumber,
    )
    for (let index = 0; index < 6; index += 1) {
      yield* makeQueuedJobsAvailable
      yield* claimAndRunPending
    }
    const paused = yield* lifecycle.getWorkItem(created.id)
    expect(paused.state).toBe("commit")
    expect(paused.paused).toBe(true)
    expect(paused.pullRequestNumber).toBeNull()
    return { repository, created: paused, lifecycle }
  })

  const runCleanupToComplete = Effect.gen(function* () {
    yield* makeQueuedJobsAvailable
    const result = yield* claimAndRunPending
    expect(result._tag).toBe("processed")
    if (result._tag !== "processed") {
      return yield* Effect.die("expected processed local cleanup")
    }
    return result.workItem
  })

  it("Completes a failed Commit with no PR after Refresh finds the Issue gone", async () => {
    let closeIssueCalls = 0
    let summaryCalls = 0
    let cleanupCalls = 0
    await Effect.runPromise(
      Effect.gen(function* () {
        const { repository, created, lifecycle } = yield* driveToFailedCommit
        const db = yield* DbService
        yield* db.deleteIssue(repository.id, created.issueNumber)

        const advanced =
          yield* lifecycle.completeParkedAttentionWhenIssueNoLongerRelevant(
            repository.id,
          )
        expect(advanced).toBe(1)

        const afterAdvance = yield* lifecycle.getWorkItem(created.id)
        expect(afterAdvance.state).toBe("local_cleanup")
        expect(afterAdvance.failureCode).toBeNull()
        expect(afterAdvance.paused).toBe(false)

        const completed = yield* runCleanupToComplete
        expect(completed.state).toBe("complete")
        expect(completed.pullRequestNumber).toBeNull()
        expect(completed.worktreePath).toBeNull()
        expect(completed.failureCode).toBeNull()
        expect(
          completed.stepRuns.some(
            (run) => run.step === "commit" && run.status === "failed",
          ),
        ).toBe(true)
        expect(completed.stepRuns.at(-1)).toMatchObject({
          step: "local_cleanup",
          status: "succeeded",
          reasonCode: STEP_RUN_REASON.native,
        })
        expect(closeIssueCalls).toBe(0)
        expect(summaryCalls).toBe(0)
        expect(cleanupCalls).toBe(1)

        const second =
          yield* lifecycle.completeParkedAttentionWhenIssueNoLongerRelevant(
            repository.id,
          )
        expect(second).toBe(0)
        const stillComplete = yield* lifecycle.getWorkItem(created.id)
        expect(stillComplete.state).toBe("complete")
      }).pipe(
        Effect.provide(
          makeLayer(
            {
              ...successfulSteps,
              commit: () =>
                Effect.fail(
                  new LifecycleStepFailedError({
                    message: "nothing to publish",
                  }),
                ),
              closeIssue: () =>
                Effect.sync(() => {
                  closeIssueCalls += 1
                }),
              localCleanup: () =>
                Effect.sync(() => {
                  cleanupCalls += 1
                }),
            },
            {
              ensureIssueCompletedWithSummary: () =>
                Effect.sync(() => {
                  summaryCalls += 1
                }),
            },
          ),
        ),
      ),
    )
  })

  it("Completes the same parked card when the Issue is still stored as CLOSED", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { repository, created, lifecycle } = yield* driveToFailedCommit
        const db = yield* DbService
        yield* db.storeIssue({
          repositoryId: repository.id,
          issueNumber: created.issueNumber,
          title: created.issueTitle ?? "Implement feature",
          body: "Issue body",
          url: "https://example.test/acme/widgets/issues/42",
          state: "CLOSED",
          githubCreatedAt: new Date("2026-01-15T12:00:00.000Z"),
          issueAuthor: null,
          parent: null,
          parentPosition: null,
          hasChildren: false,
          blockedBy: [],
        })

        expect(
          yield* lifecycle.completeParkedAttentionWhenIssueNoLongerRelevant(
            repository.id,
          ),
        ).toBe(1)
        const completed = yield* runCleanupToComplete
        expect(completed.state).toBe("complete")
      }).pipe(
        Effect.provide(
          makeLayer({
            ...successfulSteps,
            commit: () =>
              Effect.fail(
                new LifecycleStepFailedError({ message: "nothing to publish" }),
              ),
          }),
        ),
      ),
    )
  })

  it("leaves a failed Commit retryable when the Issue is still Relevant", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { repository, created, lifecycle } = yield* driveToFailedCommit
        expect(
          yield* lifecycle.completeParkedAttentionWhenIssueNoLongerRelevant(
            repository.id,
          ),
        ).toBe(0)
        const still = yield* lifecycle.getWorkItem(created.id)
        expect(still.state).toBe("commit")
        expect(still.stepRuns.at(-1)?.status).toBe("failed")

        const retried = yield* lifecycle.retry(created.id)
        expect(retried.stepRuns.at(-1)).toMatchObject({
          step: "commit",
          status: "queued",
        })
      }).pipe(
        Effect.provide(
          makeLayer({
            ...successfulSteps,
            commit: () =>
              Effect.fail(
                new LifecycleStepFailedError({ message: "nothing to publish" }),
              ),
          }),
        ),
      ),
    )
  })

  it("does not re-run Commit when Retry is used on the parked gone-Issue card", async () => {
    let commitCalls = 0
    await Effect.runPromise(
      Effect.gen(function* () {
        const { repository, created, lifecycle } = yield* driveToFailedCommit
        expect(commitCalls).toBe(1)
        const db = yield* DbService
        yield* db.deleteIssue(repository.id, created.issueNumber)

        const retried = yield* lifecycle.retry(created.id)
        expect(retried.state).toBe("local_cleanup")
        expect(commitCalls).toBe(1)

        const completed = yield* runCleanupToComplete
        expect(completed.state).toBe("complete")
        expect(commitCalls).toBe(1)
        expect(
          completed.stepRuns.filter((run) => run.step === "commit"),
        ).toHaveLength(1)
      }).pipe(
        Effect.provide(
          makeLayer({
            ...successfulSteps,
            commit: () => {
              commitCalls += 1
              return Effect.fail(
                new LifecycleStepFailedError({ message: "nothing to publish" }),
              )
            },
          }),
        ),
      ),
    )
  })

  it("skips Autonomous Retry on the parked gone-Issue card", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { repository, created, lifecycle } = yield* driveToFailedCommit
        const db = yield* DbService
        yield* db.deleteIssue(repository.id, created.issueNumber)

        const blocked = yield* Effect.flip(
          lifecycle.retry(created.id, { autonomous: { maxRetries: 3 } }),
        )
        expect(blocked).toBeInstanceOf(RetryNotEligibleError)
        if (blocked instanceof RetryNotEligibleError) {
          expect(blocked.reason).toBe("issue_no_longer_relevant")
        }
        const still = yield* lifecycle.getWorkItem(created.id)
        expect(still.state).toBe("commit")
        expect(still.stepRuns.at(-1)?.status).toBe("failed")
      }).pipe(
        Effect.provide(
          makeLayer({
            ...successfulSteps,
            commit: () =>
              Effect.fail(
                new LifecycleStepFailedError({ message: "nothing to publish" }),
              ),
          }),
        ),
      ),
    )
  })

  it("Start on a paused no-PR card Completes instead of resuming Commit", async () => {
    let commitCalls = 0
    await Effect.runPromise(
      Effect.gen(function* () {
        const { repository, created, lifecycle } = yield* driveToPausedCommit
        const db = yield* DbService
        yield* db.deleteIssue(repository.id, created.issueNumber)

        const started = yield* lifecycle.start(created.id)
        expect(started.state).toBe("local_cleanup")
        expect(started.paused).toBe(false)
        expect(commitCalls).toBe(0)

        const completed = yield* runCleanupToComplete
        expect(completed.state).toBe("complete")
        expect(commitCalls).toBe(0)
      }).pipe(
        Effect.provide(
          makeLayer({
            ...successfulSteps,
            commit: () => {
              commitCalls += 1
              return Effect.succeed({
                completion: "native" as const,
                publicationTitle: "feat: test",
                publicationBody: "Why\n\nCloses #1",
              })
            },
          }),
        ),
      ),
    )
  })

  it("leaves a running Step Run alone even when the Issue is gone", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const db = yield* DbService
        const { repository, issue } = yield* seedIssue({
          projectPath: "acme/running",
        })
        const created = yield* lifecycle.implementNow(
          repository.id,
          issue.issueNumber,
        )
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(
          `UPDATE step_run SET status = 'running' WHERE work_item_id = ?`,
          [created.id],
        )
        yield* db.deleteIssue(repository.id, issue.issueNumber)

        expect(
          yield* lifecycle.completeParkedAttentionWhenIssueNoLongerRelevant(
            repository.id,
          ),
        ).toBe(0)
        const still = yield* lifecycle.getWorkItem(created.id)
        expect(still.state).toBe("create_worktree")
        expect(still.stepRuns.at(-1)?.status).toBe("running")
      }).pipe(Effect.provide(makeLayer())),
    )
  })

  it("does not steal owned-PR Needs Human when the Issue is gone", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const db = yield* DbService
        const { repository, issue } = yield* seedIssue({
          projectPath: "acme/owned-pr",
        })
        const created = yield* lifecycle.implementNow(
          repository.id,
          issue.issueNumber,
        )
        for (let index = 0; index < 8; index += 1) {
          yield* makeQueuedJobsAvailable
          yield* claimAndRunPending
        }
        yield* sqlUnsafe(
          `UPDATE work_item SET check_start_last_observed_is_draft = NULL WHERE id = ?`,
          [created.id],
        )
        for (let index = 0; index < 2; index += 1) {
          yield* makeQueuedJobsAvailable
          yield* claimAndRunPending
        }
        const needsHuman = yield* lifecycle.getWorkItem(created.id)
        expect(needsHuman.state).toBe("needs_human")
        expect(needsHuman.pullRequestNumber).toBe(101)

        yield* db.deleteIssue(repository.id, issue.issueNumber)
        expect(
          yield* lifecycle.completeParkedAttentionWhenIssueNoLongerRelevant(
            repository.id,
          ),
        ).toBe(0)
        const still = yield* lifecycle.getWorkItem(created.id)
        expect(still.state).toBe("needs_human")
      }).pipe(
        Effect.provide(
          makeLayer({
            ...successfulSteps,
            decidePrMerge: () =>
              Effect.succeed({
                _tag: "needs_human",
                reason: AUTO_MERGE_DISABLED_FOR_REPOSITORY,
              }),
          }),
        ),
      ),
    )
  })

  it("does not Complete a competing Issue-closing PR stop", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const db = yield* DbService
        const { repository, issue } = yield* seedIssue({
          projectPath: "acme/competing",
        })
        const created = yield* lifecycle.implementNow(
          repository.id,
          issue.issueNumber,
        )
        yield* makeQueuedJobsAvailable
        yield* claimAndRunPending
        yield* lifecycle.stopForCompetingIssueClosingPullRequests(
          repository.id,
          [
            {
              issueNumber: issue.issueNumber,
              identities: [{ repository: "acme/competing", number: 1049 }],
            },
          ],
        )
        const stopped = yield* lifecycle.getWorkItem(created.id)
        expect(stopped.state).toBe("needs_human")
        expect(stopped.failureCode).toBe("issue_closing_pull_request_unowned")
        expect(stopped.pullRequestNumber).toBeNull()

        yield* db.deleteIssue(repository.id, issue.issueNumber)
        expect(
          yield* lifecycle.completeParkedAttentionWhenIssueNoLongerRelevant(
            repository.id,
          ),
        ).toBe(0)
        const still = yield* lifecycle.getWorkItem(created.id)
        expect(still.state).toBe("needs_human")
        expect(still.failureCode).toBe("issue_closing_pull_request_unowned")
      }).pipe(Effect.provide(makeLayer())),
    )
  })

  it("leaves Waiting for blockers to fail terminally instead of Completing", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const db = yield* DbService
        const { repository, issue } = yield* seedIssue({
          projectPath: "acme/blockers",
          issueNumber: 201,
        })
        yield* db.storeIssue({
          repositoryId: repository.id,
          issueNumber: 201,
          title: "Blocked",
          body: "Issue body",
          url: "https://example.test/acme/blockers/issues/201",
          state: "OPEN",
          githubCreatedAt: new Date("2026-01-15T12:00:00.000Z"),
          issueAuthor: null,
          parent: null,
          parentPosition: null,
          hasChildren: false,
          blockedBy: [
            {
              issueNumber: 1,
              issueUrl: "https://example.test/acme/blockers/issues/1",
            },
          ],
        })
        const held = yield* lifecycle.queue(repository.id, 201)
        expect(held.waitingForBlockers).toBe(true)
        yield* db.deleteIssue(repository.id, issue.issueNumber)

        expect(
          yield* lifecycle.completeParkedAttentionWhenIssueNoLongerRelevant(
            repository.id,
          ),
        ).toBe(0)
        expect(yield* lifecycle.releaseWaitingForBlockers(repository.id)).toBe(
          1,
        )
        const failed = yield* lifecycle.getWorkItem(held.id)
        expect(failed.state).toBe("failed")
        expect(failed.failureCode).toBe("issue_not_found")
      }).pipe(Effect.provide(makeLayer())),
    )
  })

  it("Completes GitLab and Azure DevOps parked cards the same way", async () => {
    for (const forge of ["gitlab", "azure-devops"] as const) {
      await Effect.runPromise(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const db = yield* DbService
          const { repository, issue } = yield* seedIssue({
            forge,
            projectPath: `acme/${forge}`,
          })
          const created = yield* lifecycle.implementNow(
            repository.id,
            issue.issueNumber,
          )
          for (let index = 0; index < 7; index += 1) {
            yield* makeQueuedJobsAvailable
            yield* claimAndRunPending
          }
          const failed = yield* lifecycle.getWorkItem(created.id)
          expect(failed.state).toBe("commit")
          yield* db.deleteIssue(repository.id, issue.issueNumber)
          expect(
            yield* lifecycle.completeParkedAttentionWhenIssueNoLongerRelevant(
              repository.id,
            ),
          ).toBe(1)
          const completed = yield* runCleanupToComplete
          expect(completed.state).toBe("complete")
        }).pipe(
          Effect.provide(
            makeLayer({
              ...successfulSteps,
              commit: () =>
                Effect.fail(
                  new LifecycleStepFailedError({
                    message: "nothing to publish",
                  }),
                ),
            }),
          ),
        ),
      )
    }
  })
})

const sqlUnsafe = (sqlText: string, params: readonly unknown[]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(sqlText, params)
  })
