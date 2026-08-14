import { Deferred, Effect, Fiber, Layer, Option } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import { GitHubService } from "@ready-for-agent/github-service"
import {
  OPERATIONAL_LIFECYCLE_STEPS,
  workItemBranchName,
} from "@ready-for-agent/lifecycle-model"
import { QueueService } from "@ready-for-agent/queue-service"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
  LifecycleSteps,
  type LifecycleStepsShape,
  STEP_RUN_REASON,
  WORK_ITEM_LIFECYCLE_QUEUE,
  WorkItemLifecycle,
  WorkItemLifecycleLive,
  WorkItemTerminalError,
  stubActiveAgentBackendLayer,
  stubGitHubServiceLayer,
  stubGitLabServiceLayer,
} from "../src/index.js"
import { describe, expect, it, setDefaultTimeout } from "bun:test"

setDefaultTimeout(30_000)

const competingObservation = {
  issueNumber: 42,
  identities: [{ repository: "acme/widgets", number: 1049 }],
} as const

const expectedMessage =
  "Open Issue-closing PR acme/widgets#1049 is not owned by this Work Item. Autonomous work stopped; review that PR, then Reset this Work Item to discard the local attempt."

describe("competing Issue-closing PR stop", () => {
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
    markPrReadyForReview: () => Effect.void,
    decidePrMerge: () => Effect.succeed({ _tag: "clanker_merge" }),
    mergePr: () => Effect.succeed({ _tag: "merged" }),
    closeIssue: () => Effect.void,
    localCleanup: () => Effect.void,
    removeWorktree: () => Effect.void,
  }

  const makeTestLayer = (
    steps: LifecycleStepsShape = successfulSteps,
    github: Parameters<typeof stubGitHubServiceLayer>[0] = {},
  ) =>
    WorkItemLifecycleLive.pipe(
      Layer.provideMerge(stubActiveAgentBackendLayer()),
      Layer.provideMerge(stubGitHubServiceLayer(github)),
      Layer.provideMerge(stubGitLabServiceLayer()),
      Layer.provideMerge(
        Layer.succeed(LifecycleSteps, LifecycleSteps.of(steps)),
      ),
      Layer.provideMerge(DbServiceLive),
      Layer.provideMerge(SqliteQueueServiceLive),
      Layer.provideMerge(DatabaseTest),
    )

  const runTest = <A, E>(
    test: Effect.Effect<
      A,
      E,
      Layer.Layer.Success<ReturnType<typeof makeTestLayer>>
    >,
    steps: LifecycleStepsShape = successfulSteps,
    github: Parameters<typeof stubGitHubServiceLayer>[0] = {},
  ): Promise<A> =>
    Effect.runPromise(Effect.provide(test, makeTestLayer(steps, github)))

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

  const setWorkItemState = (workItemId: string, state: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe(`UPDATE work_item SET state = ? WHERE id = ?`, [
        state,
        workItemId,
      ])
    })

  it("parks an eligible Work Item at Needs Human and preserves local artifacts", () =>
    runTest(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const { repository } = yield* seedActionableIssue
        const created = yield* lifecycle.implementNow(repository.id, 42)
        const stopped =
          yield* lifecycle.stopForCompetingIssueClosingPullRequests(
            repository.id,
            [competingObservation],
          )
        expect(stopped).toBe(1)
        const workItem = yield* lifecycle.getWorkItem(created.id)
        expect(workItem.state).toBe("needs_human")
        expect(workItem.failureCode).toBe("issue_closing_pull_request_unowned")
        expect(workItem.failureMessage).toBe(expectedMessage)
        expect(workItem.id).toBe(created.id)
        expect(workItem.holdsWorkerSlot).toBe(false)
        expect(workItem.paused).toBe(false)
        expect(workItem.waitingForBlockers).toBe(false)
        const queued = workItem.stepRuns.find(
          (run) => run.step === "create_worktree",
        )
        expect(queued?.status).toBe("cancelled")
        expect(queued?.reasonCode).toBe(STEP_RUN_REASON.native)
      }),
    ))

  it("is idempotent for duplicate Refresh observations", () =>
    runTest(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const { repository } = yield* seedActionableIssue
        const created = yield* lifecycle.implementNow(repository.id, 42)
        expect(
          yield* lifecycle.stopForCompetingIssueClosingPullRequests(
            repository.id,
            [competingObservation],
          ),
        ).toBe(1)
        expect(
          yield* lifecycle.stopForCompetingIssueClosingPullRequests(
            repository.id,
            [competingObservation],
          ),
        ).toBe(0)
        const workItem = yield* lifecycle.getWorkItem(created.id)
        expect(workItem.state).toBe("needs_human")
        expect(
          workItem.stepRuns.filter(
            (run) => run.reasonCode === STEP_RUN_REASON.native,
          ),
        ).toHaveLength(1)
      }),
    ))

  it("rejects Start and Retry for the competing-PR Needs Human outcome", () =>
    runTest(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const { repository } = yield* seedActionableIssue
        const created = yield* lifecycle.implementNow(repository.id, 42)
        yield* lifecycle.stopForCompetingIssueClosingPullRequests(
          repository.id,
          [competingObservation],
        )
        const startError = yield* lifecycle.start(created.id).pipe(Effect.flip)
        expect(startError).toBeInstanceOf(WorkItemTerminalError)
        const retryError = yield* lifecycle.retry(created.id).pipe(Effect.flip)
        expect(retryError).toBeInstanceOf(WorkItemTerminalError)
      }),
    ))

  it("does not overwrite an existing Needs Human reason", () =>
    runTest(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const { repository } = yield* seedActionableIssue
        const created = yield* lifecycle.implementNow(repository.id, 42)
        yield* setWorkItemState(created.id, "needs_human")
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(
          `UPDATE work_item
           SET failure_code = 'needs_human',
               failure_message = 'Human merge decision required'
           WHERE id = ?`,
          [created.id],
        )
        expect(
          yield* lifecycle.stopForCompetingIssueClosingPullRequests(
            repository.id,
            [competingObservation],
          ),
        ).toBe(0)
        const workItem = yield* lifecycle.getWorkItem(created.id)
        expect(workItem.failureMessage).toBe("Human merge decision required")
      }),
    ))

  it("clears Waiting for blockers when a competing PR is observed", () =>
    runTest(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const db = yield* DbService
        yield* seedHarnessBuildModel
        const repository = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme-blocked.git",
          isBare: true,
        })
        yield* db.storeIssue({
          repositoryId: repository.id,
          issueNumber: 42,
          title: "Blocked feature",
          body: "Issue body",
          url: "https://github.com/acme/widgets/issues/42",
          state: "OPEN",
          githubCreatedAt: new Date("2026-01-15T12:00:00.000Z"),
          issueAuthor: null,
          parent: null,
          parentPosition: null,
          hasChildren: false,
          blockedBy: [
            {
              issueNumber: 7,
              issueUrl: "https://github.com/acme/widgets/issues/7",
            },
          ],
        })
        const queued = yield* lifecycle.queue(repository.id, 42)
        expect(queued.waitingForBlockers).toBe(true)
        expect(
          yield* lifecycle.stopForCompetingIssueClosingPullRequests(
            repository.id,
            [competingObservation],
          ),
        ).toBe(1)
        const workItem = yield* lifecycle.getWorkItem(queued.id)
        expect(workItem.state).toBe("needs_human")
        expect(workItem.waitingForBlockers).toBe(false)
        expect(workItem.holdsWorkerSlot).toBe(false)
      }),
    ))

  it("leaves local cleanup and terminal Work Items unchanged", () =>
    runTest(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const { repository } = yield* seedActionableIssue
        const created = yield* lifecycle.implementNow(repository.id, 42)
        for (const state of [
          "local_cleanup",
          "complete",
          "failed",
          "abandoned",
        ] as const) {
          yield* setWorkItemState(created.id, state)
          expect(
            yield* lifecycle.stopForCompetingIssueClosingPullRequests(
              repository.id,
              [competingObservation],
            ),
          ).toBe(0)
          expect((yield* lifecycle.getWorkItem(created.id)).state).toBe(state)
        }
      }),
    ))

  for (const state of OPERATIONAL_LIFECYCLE_STEPS.filter(
    (step) => step !== "local_cleanup",
  )) {
    it(`transitions ${state} to Needs Human`, () =>
      runTest(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const { repository } = yield* seedActionableIssue
          const created = yield* lifecycle.implementNow(repository.id, 42)
          yield* setWorkItemState(created.id, state)
          expect(
            yield* lifecycle.stopForCompetingIssueClosingPullRequests(
              repository.id,
              [competingObservation],
            ),
          ).toBe(1)
          const workItem = yield* lifecycle.getWorkItem(created.id)
          expect(workItem.state).toBe("needs_human")
          expect(workItem.failureCode).toBe(
            "issue_closing_pull_request_unowned",
          )
        }),
      ))
  }

  it("interrupts a running Step Run and does not start a successor", async () => {
    const started = await Effect.runPromise(Deferred.make<void>())
    const interrupted = await Effect.runPromise(Deferred.make<void>())
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      createWorktree: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(interrupted, undefined)),
        ),
    }

    await runTest(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const queue = yield* QueueService
        const { repository } = yield* seedActionableIssue
        const created = yield* lifecycle.implementNow(repository.id, 42)
        const job = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
        if (Option.isNone(job)) {
          return yield* Effect.die("expected create worktree job")
        }
        const runFiber = yield* lifecycle
          .runStep((job.value.payload as { stepRunId: string }).stepRunId)
          .pipe(Effect.forkChild)
        yield* Deferred.await(started)

        const stopped =
          yield* lifecycle.stopForCompetingIssueClosingPullRequests(
            repository.id,
            [competingObservation],
          )
        expect(stopped).toBe(1)
        expect(yield* Deferred.isDone(interrupted)).toBe(true)
        yield* Fiber.join(runFiber)
        const workItem = yield* lifecycle.getWorkItem(created.id)
        expect(workItem.state).toBe("needs_human")
        expect(
          workItem.stepRuns.some(
            (run) =>
              run.step === "create_worktree" && run.status === "interrupted",
          ),
        ).toBe(true)
        const leftover = yield* queue.rawClaim(WORK_ITEM_LIFECYCLE_QUEUE)
        expect(Option.isNone(leftover)).toBe(true)
      }),
      steps,
    )
  })

  it("Reset removes the Work Item without closing the competing PR", () => {
    const closedBranches: string[] = []
    return runTest(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const { repository } = yield* seedActionableIssue
        const created = yield* lifecycle.implementNow(repository.id, 42)
        yield* lifecycle.stopForCompetingIssueClosingPullRequests(
          repository.id,
          [competingObservation],
        )
        const resetId = yield* lifecycle.reset(created.id)
        expect(resetId).toBe(created.id)
        const missing = yield* lifecycle
          .getWorkItem(created.id)
          .pipe(Effect.flip)
        expect(missing._tag).toBe("WorkItemNotFoundError")
        expect(closedBranches).toEqual([
          workItemBranchName({
            projectPath: "acme/widgets",
            issueNumber: 42,
            workItemId: created.id,
          }),
        ])
      }),
      {
        ...successfulSteps,
        removeWorktree: (context) =>
          Effect.gen(function* () {
            const github = yield* GitHubService
            yield* github.closeOpenPullRequestsAndDeleteBranch(
              {
                forge: "github",
                forgeHost: "github.com",
                projectPath: "acme/widgets",
              },
              workItemBranchName({
                projectPath: "acme/widgets",
                issueNumber: context.issueNumber,
                workItemId: context.workItemId,
              }),
            )
          }),
      },
      {
        closeOpenPullRequestsAndDeleteBranch: (_repository, branch) =>
          Effect.sync(() => {
            closedBranches.push(branch)
          }),
      },
    )
  })
})
