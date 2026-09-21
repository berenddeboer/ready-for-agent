import { Effect, Layer } from "effect"
import { AGENT_BACKEND_IDS } from "@ready-for-agent/agent-backend"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import type { LinearServiceTestFixture } from "@ready-for-agent/linear-service"
import {
  LinearRequestError,
  linearMilestoneMarker,
} from "@ready-for-agent/linear-service"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
  LINEAR_MERGE_COMPLETION_SUMMARY,
  LifecycleSteps,
  type LifecycleStepsShape,
  WorkItemLifecycle,
  WorkItemLifecycleLive,
  closeIssue,
  linearCompletionComment,
  stubActiveAgentBackendLayer,
  stubAzureDevOpsServiceLayer,
  stubGitHubServiceLayer,
  stubGitLabServiceLayer,
  stubLinearServiceLayer,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const successfulSteps: LifecycleStepsShape = {
  createWorktree: () =>
    Effect.succeed({
      worktreePath: "/tmp/worktrees/acme-widgets-linear",
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
      publicationBody:
        "Why\n\nLinear: ENG-123\nhttps://linear.app/acme/issue/ENG-123",
    }),
  createPr: () =>
    Effect.succeed({
      pullRequestNumber: 101,
      completion: "native" as const,
      publicationTitle: "feat: test",
      publicationBody:
        "Why\n\nLinear: ENG-123\nhttps://linear.app/acme/issue/ENG-123",
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

const linearWorkflow = {
  teamId: "team-eng",
  teamKey: "ENG",
  teamName: "Engineering",
  inProgressStateId: "progress",
  inProgressStateName: "In Progress",
  doneStateId: "done",
  doneStateName: "Done",
} as const

const linearNativeId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"

const noChangeMustNotPublish = {
  preCommit: () => Effect.die("pre-commit must not run for NO_CHANGES"),
  review: () => Effect.die("review must not run for NO_CHANGES"),
  commit: () => Effect.die("commit must not run for NO_CHANGES"),
  createPr: () => Effect.die("create PR must not run for NO_CHANGES"),
  watchPrStatusChecks: () =>
    Effect.die("status checks must not run for NO_CHANGES"),
  resolvePrMergeConflict: () =>
    Effect.die("merge conflict must not run for NO_CHANGES"),
  investigatePrStatusChecks: () =>
    Effect.die("investigate checks must not run for NO_CHANGES"),
  markPrReadyForReview: () =>
    Effect.die("mark ready must not run for NO_CHANGES"),
  decidePrMerge: () => Effect.die("decide merge must not run for NO_CHANGES"),
  mergePr: () => Effect.die("merge PR must not run for NO_CHANGES"),
} satisfies Partial<LifecycleStepsShape>

const linearLifecycleLayer = (
  steps: LifecycleStepsShape,
  linear: LinearServiceTestFixture = {},
) =>
  WorkItemLifecycleLive.pipe(
    Layer.provideMerge(stubActiveAgentBackendLayer()),
    Layer.provideMerge(
      stubGitHubServiceLayer({
        ensureIssueCompletedWithSummary: () =>
          Effect.die("GitHub close-out must not run for a Linear Issue"),
      }),
    ),
    Layer.provideMerge(stubGitLabServiceLayer()),
    Layer.provideMerge(stubAzureDevOpsServiceLayer()),
    Layer.provideMerge(stubLinearServiceLayer(linear)),
    Layer.provideMerge(Layer.succeed(LifecycleSteps, LifecycleSteps.of(steps))),
    Layer.provideMerge(DbServiceLive),
    Layer.provideMerge(SqliteQueueServiceLive),
    Layer.provideMerge(DatabaseTest),
  )

const seedLinearNoChangeRepository = (localPath: string) =>
  Effect.gen(function* () {
    const db = yield* DbService
    const repo = yield* db.addRepository({
      forge: "github",
      forgeHost: "github.com",
      projectPath: "acme/widgets",
      localPath,
      isBare: true,
    })
    yield* db.updateRepositorySettings({
      repositoryId: repo.id,
      paused: true,
      defaultModel: null,
      defaultThinkingLevel: null,
      reviewModel: null,
      reviewThinkingLevel: null,
      mergePolicy: "off",
      includeAllIssueAuthors: false,
      waitForReadyForReviewChecks: true,
      issueTracker: "linear",
      linearProjectId: "proj-1",
      linearProjectName: "Widgets",
      linearWorkflowStatuses: [linearWorkflow],
    })
    yield* db.updateConfig({
      selectedAgentBackend: AGENT_BACKEND_IDS.opencode,
      defaultModel: "opencode/deepseek-v4-flash-free",
      defaultThinkingLevel: null,
      reviewModel: null,
      reviewThinkingLevel: null,
      maxConcurrentAgentTurns: 2,
      maxConcurrentWorkItems: 5,
    })
    yield* db.storeIssue({
      repositoryId: repo.id,
      issueNumber: 123,
      issueTracker: "linear",
      nativeId: linearNativeId,
      displayId: "ENG-123",
      title: "No repository change",
      body: "Answer the question in Linear.",
      url: "https://linear.app/acme/issue/ENG-123",
      state: "OPEN",
      githubCreatedAt: new Date(),
      issueAuthor: null,
      parent: null,
      parentPosition: null,
      hasChildren: false,
      blockedBy: [],
    })
    return repo
  })

const seedLinearMergeRepository = (localPath: string) =>
  Effect.gen(function* () {
    const db = yield* DbService
    const repo = yield* db.addRepository({
      forge: "github",
      forgeHost: "github.com",
      projectPath: "acme/widgets",
      localPath,
      isBare: true,
    })
    yield* db.updateRepositorySettings({
      repositoryId: repo.id,
      paused: true,
      defaultModel: null,
      defaultThinkingLevel: null,
      reviewModel: null,
      reviewThinkingLevel: null,
      mergePolicy: "off",
      includeAllIssueAuthors: false,
      waitForReadyForReviewChecks: false,
      issueTracker: "linear",
      linearProjectId: "proj-1",
      linearProjectName: "Widgets",
      linearWorkflowStatuses: [linearWorkflow],
    })
    yield* db.updateConfig({
      selectedAgentBackend: AGENT_BACKEND_IDS.opencode,
      defaultModel: "opencode/deepseek-v4-flash-free",
      defaultThinkingLevel: null,
      reviewModel: null,
      reviewThinkingLevel: null,
      maxConcurrentAgentTurns: 2,
      maxConcurrentWorkItems: 5,
    })
    yield* db.storeIssue({
      repositoryId: repo.id,
      issueNumber: 123,
      issueTracker: "linear",
      nativeId: linearNativeId,
      displayId: "ENG-123",
      title: "Linear leaf",
      body: "Implement in GitHub.",
      url: "https://linear.app/acme/issue/ENG-123",
      state: "OPEN",
      githubCreatedAt: new Date(),
      issueAuthor: null,
      parent: null,
      parentPosition: null,
      hasChildren: false,
      blockedBy: [],
    })
    return repo
  })

const runQueuedSteps = (workItemId: string, stopAt?: string) =>
  Effect.gen(function* () {
    const lifecycle = yield* WorkItemLifecycle
    let current = yield* lifecycle.getWorkItem(workItemId)
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (stopAt !== undefined && current.state === stopAt) {
        return current
      }
      const queued = current.stepRuns.find((run) => run.status === "queued")
      if (queued === undefined) {
        return current
      }
      yield* lifecycle.runStep(queued.id)
      current = yield* lifecycle.getWorkItem(workItemId)
    }
    return current
  })

describe("Linear Issue execution", () => {
  it("keeps GitHub Work Items on GitHub after the tracker switches, and starts Linear Work Items on Linear", async () => {
    const comments: Array<{ nativeId: string; marker: string }> = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets-mixed.git",
          isBare: true,
        })
        yield* db.updateConfig({
          selectedAgentBackend: AGENT_BACKEND_IDS.opencode,
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultThinkingLevel: null,
          reviewModel: null,
          reviewThinkingLevel: null,
          maxConcurrentAgentTurns: 2,
          maxConcurrentWorkItems: 5,
        })
        yield* db.storeIssue({
          repositoryId: repo.id,
          issueNumber: 17,
          title: "GitHub leaf",
          body: "body",
          url: "https://github.com/acme/widgets/issues/17",
          state: "OPEN",
          githubCreatedAt: new Date(),
          issueAuthor: null,
          parent: null,
          parentPosition: null,
          hasChildren: false,
          blockedBy: [],
        })
        const githubWork = yield* lifecycle.implementNow(repo.id, "17")
        expect(githubWork.issueSource).toEqual({
          tracker: "github",
          nativeId: "17",
          displayId: "17",
          url: "https://github.com/acme/widgets/issues/17",
        })

        yield* db.updateRepositorySettings({
          repositoryId: repo.id,
          paused: true,
          defaultModel: null,
          defaultThinkingLevel: null,
          reviewModel: null,
          reviewThinkingLevel: null,
          mergePolicy: "off",
          includeAllIssueAuthors: false,
          waitForReadyForReviewChecks: true,
          issueTracker: "linear",
          linearProjectId: "proj-1",
          linearProjectName: "Widgets",
          linearWorkflowStatuses: [linearWorkflow],
        })
        const switched = (yield* db.listRepositories).find(
          (candidate) => candidate.id === repo.id,
        )
        expect(switched?.issueTracker).toBe("linear")
        expect(switched?.forge).toBe("github")

        const reloadedGithub = yield* lifecycle.getWorkItem(githubWork.id)
        expect(reloadedGithub.issueSource.tracker).toBe("github")

        const nativeId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        yield* db.storeIssue({
          repositoryId: repo.id,
          issueNumber: 123,
          issueTracker: "linear",
          nativeId,
          displayId: "ENG-123",
          title: "Linear leaf",
          body: "Implement in GitHub.",
          url: "https://linear.app/acme/issue/ENG-123",
          state: "OPEN",
          githubCreatedAt: new Date(),
          issueAuthor: null,
          parent: null,
          parentPosition: null,
          hasChildren: false,
          blockedBy: [],
        })
        const linearWork = yield* lifecycle.implementNow(
          repo.id,
          linearNativeId,
        )
        expect(linearWork.issueSource).toEqual({
          tracker: "linear",
          nativeId,
          displayId: "ENG-123",
          url: "https://linear.app/acme/issue/ENG-123",
        })
        expect(linearWork.issueSource.nativeId).not.toBe("123")
      }).pipe(
        Effect.provide(
          WorkItemLifecycleLive.pipe(
            Layer.provideMerge(stubActiveAgentBackendLayer()),
            Layer.provideMerge(stubGitHubServiceLayer()),
            Layer.provideMerge(stubGitLabServiceLayer()),
            Layer.provideMerge(stubAzureDevOpsServiceLayer()),
            Layer.provideMerge(
              stubLinearServiceLayer({
                ensureMilestoneComment: (nativeId, marker) =>
                  Effect.sync(() => {
                    comments.push({ nativeId, marker })
                  }),
              }),
            ),
            Layer.provideMerge(
              Layer.succeed(LifecycleSteps, LifecycleSteps.of(successfulSteps)),
            ),
            Layer.provideMerge(DbServiceLive),
            Layer.provideMerge(SqliteQueueServiceLive),
            Layer.provideMerge(DatabaseTest),
          ),
        ),
      ),
    )
    expect(comments).toEqual([])
  })

  it("posts a Linear human-attention comment when a Linear Work Item needs human", async () => {
    const comments: Array<{ nativeId: string; marker: string; body: string }> =
      []
    const nativeId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets-linear-attention.git",
          isBare: true,
        })
        yield* db.updateRepositorySettings({
          repositoryId: repo.id,
          paused: true,
          defaultModel: null,
          defaultThinkingLevel: null,
          reviewModel: null,
          reviewThinkingLevel: null,
          mergePolicy: "off",
          includeAllIssueAuthors: false,
          waitForReadyForReviewChecks: true,
          issueTracker: "linear",
          linearProjectId: "proj-1",
          linearProjectName: "Widgets",
          linearWorkflowStatuses: [linearWorkflow],
        })
        yield* db.updateConfig({
          selectedAgentBackend: AGENT_BACKEND_IDS.opencode,
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultThinkingLevel: null,
          reviewModel: null,
          reviewThinkingLevel: null,
          maxConcurrentAgentTurns: 2,
          maxConcurrentWorkItems: 5,
        })
        yield* db.storeIssue({
          repositoryId: repo.id,
          issueNumber: 123,
          issueTracker: "linear",
          nativeId,
          displayId: "ENG-123",
          title: "Needs a reviewer",
          body: "body",
          url: "https://linear.app/acme/issue/ENG-123",
          state: "OPEN",
          githubCreatedAt: new Date(),
          issueAuthor: null,
          parent: null,
          parentPosition: null,
          hasChildren: false,
          blockedBy: [],
        })
        const created = yield* lifecycle.implementNow(repo.id, linearNativeId)
        let current = created
        for (let attempt = 0; attempt < 8; attempt += 1) {
          if (current.state === "needs_human") {
            break
          }
          const queued = current.stepRuns.find((run) => run.status === "queued")
          if (queued === undefined) {
            break
          }
          yield* lifecycle.runStep(queued.id)
          current = yield* lifecycle.getWorkItem(created.id)
        }
        expect(current.state).toBe("needs_human")
        expect(comments).toHaveLength(1)
        expect(comments[0]?.nativeId).toBe(nativeId)
        expect(comments[0]?.marker).toBe(
          linearMilestoneMarker("human-attention", created.id),
        )
        expect(comments[0]?.body).toContain("High-severity findings remain.")
      }).pipe(
        Effect.provide(
          WorkItemLifecycleLive.pipe(
            Layer.provideMerge(stubActiveAgentBackendLayer()),
            Layer.provideMerge(stubGitHubServiceLayer()),
            Layer.provideMerge(stubGitLabServiceLayer()),
            Layer.provideMerge(stubAzureDevOpsServiceLayer()),
            Layer.provideMerge(
              stubLinearServiceLayer({
                ensureMilestoneComment: (id, marker, body) =>
                  Effect.sync(() => {
                    comments.push({ nativeId: id, marker, body })
                  }),
              }),
            ),
            Layer.provideMerge(
              Layer.succeed(
                LifecycleSteps,
                LifecycleSteps.of({
                  ...successfulSteps,
                  review: () =>
                    Effect.succeed({
                      _tag: "needs_human" as const,
                      reason: "High-severity findings remain.",
                    }),
                }),
              ),
            ),
            Layer.provideMerge(DbServiceLive),
            Layer.provideMerge(SqliteQueueServiceLive),
            Layer.provideMerge(DatabaseTest),
          ),
        ),
      ),
    )
  })

  it("fails Linear attention as a Linear error without parking Needs Human", async () => {
    const nativeId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets-linear-attention-fail.git",
          isBare: true,
        })
        yield* db.updateRepositorySettings({
          repositoryId: repo.id,
          paused: true,
          defaultModel: null,
          defaultThinkingLevel: null,
          reviewModel: null,
          reviewThinkingLevel: null,
          mergePolicy: "off",
          includeAllIssueAuthors: false,
          waitForReadyForReviewChecks: true,
          issueTracker: "linear",
          linearProjectId: "proj-1",
          linearProjectName: "Widgets",
          linearWorkflowStatuses: [linearWorkflow],
        })
        yield* db.updateConfig({
          selectedAgentBackend: AGENT_BACKEND_IDS.opencode,
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultThinkingLevel: null,
          reviewModel: null,
          reviewThinkingLevel: null,
          maxConcurrentAgentTurns: 2,
          maxConcurrentWorkItems: 5,
        })
        yield* db.storeIssue({
          repositoryId: repo.id,
          issueNumber: 123,
          issueTracker: "linear",
          nativeId,
          displayId: "ENG-123",
          title: "Needs a reviewer",
          body: "body",
          url: "https://linear.app/acme/issue/ENG-123",
          state: "OPEN",
          githubCreatedAt: new Date(),
          issueAuthor: null,
          parent: null,
          parentPosition: null,
          hasChildren: false,
          blockedBy: [],
        })
        const created = yield* lifecycle.implementNow(repo.id, linearNativeId)
        let current = created
        let failure: unknown
        for (let attempt = 0; attempt < 8; attempt += 1) {
          if (current.state === "needs_human") {
            break
          }
          const queued = current.stepRuns.find((run) => run.status === "queued")
          if (queued === undefined) {
            break
          }
          const stepResult = yield* lifecycle
            .runStep(queued.id)
            .pipe(Effect.result)
          if (stepResult._tag === "Failure") {
            failure = stepResult.failure
            break
          }
          current = yield* lifecycle.getWorkItem(created.id)
        }
        const parked = yield* lifecycle.getWorkItem(created.id)
        return { failure, state: parked.state }
      }).pipe(
        Effect.provide(
          WorkItemLifecycleLive.pipe(
            Layer.provideMerge(stubActiveAgentBackendLayer()),
            Layer.provideMerge(stubGitHubServiceLayer()),
            Layer.provideMerge(stubGitLabServiceLayer()),
            Layer.provideMerge(stubAzureDevOpsServiceLayer()),
            Layer.provideMerge(
              stubLinearServiceLayer({
                ensureMilestoneComment: () =>
                  Effect.fail(
                    new LinearRequestError({
                      message: "Linear comment API unavailable",
                    }),
                  ),
              }),
            ),
            Layer.provideMerge(
              Layer.succeed(
                LifecycleSteps,
                LifecycleSteps.of({
                  ...successfulSteps,
                  review: () =>
                    Effect.succeed({
                      _tag: "needs_human" as const,
                      reason: "High-severity findings remain.",
                    }),
                }),
              ),
            ),
            Layer.provideMerge(DbServiceLive),
            Layer.provideMerge(SqliteQueueServiceLive),
            Layer.provideMerge(DatabaseTest),
          ),
        ),
      ),
    )

    expect(result.state).not.toBe("needs_human")
    expect(result.failure).toBeInstanceOf(LinearRequestError)
    expect(String(result.failure)).not.toContain(
      "Unexpected transaction failure",
    )
  })

  it("revalidates a Linear Work Item by nativeId when leftover GitHub shares the number", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets-linear-revalidate.git",
          isBare: true,
        })
        yield* db.updateRepositorySettings({
          repositoryId: repo.id,
          paused: true,
          defaultModel: null,
          defaultThinkingLevel: null,
          reviewModel: null,
          reviewThinkingLevel: null,
          mergePolicy: "off",
          includeAllIssueAuthors: false,
          waitForReadyForReviewChecks: true,
          issueTracker: "linear",
          linearProjectId: "proj-1",
          linearProjectName: "Widgets",
          linearWorkflowStatuses: [linearWorkflow],
        })
        yield* db.updateConfig({
          selectedAgentBackend: AGENT_BACKEND_IDS.opencode,
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultThinkingLevel: null,
          reviewModel: null,
          reviewThinkingLevel: null,
          maxConcurrentAgentTurns: 2,
          maxConcurrentWorkItems: 5,
        })
        yield* db.storeIssue({
          repositoryId: repo.id,
          issueNumber: 123,
          issueTracker: "github",
          nativeId: "123",
          displayId: "123",
          title: "GitHub leftover parent",
          body: "Wrong issue.",
          url: "https://github.com/acme/widgets/issues/123",
          state: "CLOSED",
          githubCreatedAt: new Date(),
          issueAuthor: null,
          parent: null,
          parentPosition: null,
          hasChildren: true,
          blockedBy: [],
        })
        const nativeId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        yield* db.storeIssue({
          repositoryId: repo.id,
          issueNumber: 123,
          issueTracker: "linear",
          nativeId,
          displayId: "ENG-123",
          title: "Linear leaf",
          body: "Implement in GitHub.",
          url: "https://linear.app/acme/issue/ENG-123",
          state: "OPEN",
          githubCreatedAt: new Date(),
          issueAuthor: null,
          parent: null,
          parentPosition: null,
          hasChildren: false,
          blockedBy: [],
        })
        const created = yield* lifecycle.implementNow(repo.id, linearNativeId)
        const queued = created.stepRuns.find((run) => run.status === "queued")
        expect(queued).toBeDefined()
        const result = yield* lifecycle.runStep(queued!.id)
        expect(result._tag).toBe("processed")
        if (result._tag !== "processed") {
          return
        }
        expect(result.workItem.state).not.toBe("failed")
        expect(result.workItem.failureCode).toBeNull()
      }).pipe(
        Effect.provide(
          WorkItemLifecycleLive.pipe(
            Layer.provideMerge(stubActiveAgentBackendLayer()),
            Layer.provideMerge(stubGitHubServiceLayer()),
            Layer.provideMerge(stubGitLabServiceLayer()),
            Layer.provideMerge(stubAzureDevOpsServiceLayer()),
            Layer.provideMerge(stubLinearServiceLayer()),
            Layer.provideMerge(
              Layer.succeed(LifecycleSteps, LifecycleSteps.of(successfulSteps)),
            ),
            Layer.provideMerge(DbServiceLive),
            Layer.provideMerge(SqliteQueueServiceLive),
            Layer.provideMerge(DatabaseTest),
          ),
        ),
      ),
    )
  })

  it("completes a Linear No-Change Outcome through Close Issue without a GitHub PR", async () => {
    const summary = "The answer is already in Linear; no repository changes."
    const states: string[] = []
    const comments: Array<{ nativeId: string; marker: string; body: string }> =
      []
    let implementCalls = 0
    const completed = await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* seedLinearNoChangeRepository(
          "/repos/acme/widgets-linear-no-change.git",
        )
        const created = yield* lifecycle.implementNow(repo.id, linearNativeId)
        const finished = yield* runQueuedSteps(created.id)
        return { created, finished }
      }).pipe(
        Effect.provide(
          linearLifecycleLayer(
            {
              ...successfulSteps,
              ...noChangeMustNotPublish,
              implement: () => {
                implementCalls += 1
                return Effect.succeed("ses_linear_no_change")
              },
              assessChanges: () =>
                Effect.succeed({
                  _tag: "no_changes",
                  completionSummary: summary,
                }),
              closeIssue,
            },
            {
              issue: {
                id: linearNativeId,
                identifier: "ENG-123",
                url: "https://linear.app/acme/issue/ENG-123",
                teamId: linearWorkflow.teamId,
                teamKey: linearWorkflow.teamKey,
                stateId: "todo",
                stateName: "Todo",
                stateType: "unstarted",
              },
              updateIssueState: (_id, stateId) =>
                Effect.sync(() => {
                  states.push(stateId)
                }),
              ensureMilestoneComment: (nativeId, marker, body) =>
                Effect.sync(() => {
                  comments.push({ nativeId, marker, body })
                }),
            },
          ),
        ),
      ),
    )

    expect(completed.finished.state).toBe("complete")
    expect(completed.finished.completionSummary).toBe(summary)
    expect(completed.finished.pullRequestNumber).toBeNull()
    expect(implementCalls).toBe(1)
    expect(states).toEqual(["done"])
    expect(comments).toEqual([
      {
        nativeId: linearNativeId,
        marker: linearMilestoneMarker("completion", completed.created.id),
        body: linearCompletionComment(completed.created.id, summary),
      },
    ])
    expect(
      completed.finished.stepRuns.map((run) => [run.step, run.status]),
    ).toEqual([
      ["create_worktree", "succeeded"],
      ["install_dependencies", "succeeded"],
      ["implement", "succeeded"],
      ["assess_changes", "succeeded"],
      ["close_issue", "succeeded"],
      ["local_cleanup", "succeeded"],
    ])
  })

  it("retries Linear Close Issue after a tracker failure without restarting implementation", async () => {
    const summary = "Summary retained across Linear close-out retry."
    const states: string[] = []
    const comments: string[] = []
    let implementCalls = 0
    let closeAttempts = 0
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* seedLinearNoChangeRepository(
          "/repos/acme/widgets-linear-no-change-retry.git",
        )
        const created = yield* lifecycle.implementNow(repo.id, linearNativeId)
        const afterFailure = yield* runQueuedSteps(created.id)
        expect(afterFailure.state).toBe("close_issue")
        expect(afterFailure.completionSummary).toBe(summary)
        expect(afterFailure.pullRequestNumber).toBeNull()
        expect(afterFailure.stepRuns.at(-1)?.status).toBe("failed")
        expect(implementCalls).toBe(1)

        yield* lifecycle.retry(afterFailure.id)
        const finished = yield* runQueuedSteps(created.id)
        return { created, finished }
      }).pipe(
        Effect.provide(
          linearLifecycleLayer(
            {
              ...successfulSteps,
              ...noChangeMustNotPublish,
              implement: () => {
                implementCalls += 1
                return Effect.succeed("ses_linear_no_change_retry")
              },
              assessChanges: () =>
                Effect.succeed({
                  _tag: "no_changes",
                  completionSummary: summary,
                }),
              closeIssue,
            },
            {
              issue: {
                id: linearNativeId,
                identifier: "ENG-123",
                url: "https://linear.app/acme/issue/ENG-123",
                teamId: linearWorkflow.teamId,
                teamKey: linearWorkflow.teamKey,
                stateId: "todo",
                stateName: "Todo",
                stateType: "unstarted",
              },
              updateIssueState: (_id, stateId) =>
                Effect.sync(() => {
                  states.push(stateId)
                }),
              ensureMilestoneComment: (_id, marker) => {
                closeAttempts += 1
                if (closeAttempts === 1) {
                  return Effect.fail(
                    new LinearRequestError({
                      message: "Linear comment API unavailable",
                    }),
                  )
                }
                return Effect.sync(() => {
                  comments.push(marker)
                })
              },
            },
          ),
        ),
      ),
    )

    expect(result.finished.state).toBe("complete")
    expect(result.finished.completionSummary).toBe(summary)
    expect(result.finished.pullRequestNumber).toBeNull()
    expect(implementCalls).toBe(1)
    expect(closeAttempts).toBe(2)
    expect(states).toEqual(["done"])
    expect(comments).toEqual([
      linearMilestoneMarker("completion", result.created.id),
    ])
  })

  it("accepts an already-completed Linear Issue on the no-change Close Issue path", async () => {
    const summary = "Decision already recorded; no repository changes."
    const states: string[] = []
    const comments: string[] = []
    const finished = await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* seedLinearNoChangeRepository(
          "/repos/acme/widgets-linear-already-done.git",
        )
        const created = yield* lifecycle.implementNow(repo.id, linearNativeId)
        return yield* runQueuedSteps(created.id)
      }).pipe(
        Effect.provide(
          linearLifecycleLayer(
            {
              ...successfulSteps,
              ...noChangeMustNotPublish,
              assessChanges: (context) =>
                Effect.gen(function* () {
                  const db = yield* DbService
                  yield* db.storeIssue({
                    repositoryId: context.repositoryId,
                    issueNumber: 123,
                    issueTracker: "linear",
                    nativeId: linearNativeId,
                    displayId: "ENG-123",
                    title: "No repository change",
                    body: "Answer the question in Linear.",
                    url: "https://linear.app/acme/issue/ENG-123",
                    state: "CLOSED",
                    githubCreatedAt: new Date(),
                    issueAuthor: null,
                    parent: null,
                    parentPosition: null,
                    hasChildren: false,
                    blockedBy: [],
                  })
                  return {
                    _tag: "no_changes" as const,
                    completionSummary: summary,
                  }
                }),
              closeIssue,
            },
            {
              issue: {
                id: linearNativeId,
                identifier: "ENG-123",
                url: "https://linear.app/acme/issue/ENG-123",
                teamId: linearWorkflow.teamId,
                teamKey: linearWorkflow.teamKey,
                stateId: "done",
                stateName: "Done",
                stateType: "completed",
              },
              updateIssueState: (_id, stateId) =>
                Effect.sync(() => {
                  states.push(stateId)
                }),
              ensureMilestoneComment: (_id, marker) =>
                Effect.sync(() => {
                  comments.push(marker)
                }),
            },
          ),
        ),
      ),
    )

    expect(finished.state).toBe("complete")
    expect(finished.completionSummary).toBe(summary)
    expect(finished.pullRequestNumber).toBeNull()
    expect(states).toEqual(["done"])
    expect(comments).toHaveLength(1)
    expect(comments[0]).toContain("completion")
  })

  it("completes Linear after a harness-performed GitHub merge", async () => {
    const states: string[] = []
    const comments: Array<{ nativeId: string; marker: string; body: string }> =
      []
    let mergeCalls = 0
    let createPrCalls = 0
    const finished = await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* seedLinearMergeRepository(
          "/repos/acme/widgets-linear-merge.git",
        )
        const created = yield* lifecycle.implementNow(repo.id, linearNativeId)
        const current = yield* runQueuedSteps(created.id)
        return { created, current }
      }).pipe(
        Effect.provide(
          linearLifecycleLayer(
            {
              ...successfulSteps,
              createPr: () => {
                createPrCalls += 1
                return successfulSteps.createPr({} as never)
              },
              mergePr: () => {
                mergeCalls += 1
                return Effect.succeed({ _tag: "merged" as const })
              },
              closeIssue,
            },
            {
              issue: {
                id: linearNativeId,
                identifier: "ENG-123",
                url: "https://linear.app/acme/issue/ENG-123",
                teamId: linearWorkflow.teamId,
                teamKey: linearWorkflow.teamKey,
                stateId: "todo",
                stateName: "Todo",
                stateType: "unstarted",
              },
              updateIssueState: (_id, stateId) =>
                Effect.sync(() => {
                  states.push(stateId)
                }),
              ensureMilestoneComment: (nativeId, marker, body) =>
                Effect.sync(() => {
                  comments.push({ nativeId, marker, body })
                }),
            },
          ),
        ),
      ),
    )

    expect(finished.current.state).toBe("complete")
    expect(mergeCalls).toBe(1)
    expect(createPrCalls).toBe(1)
    expect(states).toEqual(["done"])
    expect(comments).toEqual([
      {
        nativeId: linearNativeId,
        marker: linearMilestoneMarker("completion", finished.created.id),
        body: linearCompletionComment(
          finished.created.id,
          LINEAR_MERGE_COMPLETION_SUMMARY,
        ),
      },
    ])
    expect(
      finished.current.stepRuns.map((run) => [run.step, run.status]),
    ).toContainEqual(["close_issue", "succeeded"])
    expect(
      finished.current.stepRuns.some((run) => run.step === "merge_pr"),
    ).toBe(true)
  })

  it("completes Linear after an observed human-performed GitHub merge", async () => {
    const states: string[] = []
    const comments: Array<{ marker: string; body: string }> = []
    let mergeCalls = 0
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* seedLinearMergeRepository(
          "/repos/acme/widgets-linear-human-merge.git",
        )
        const created = yield* lifecycle.implementNow(repo.id, linearNativeId)
        const parked = yield* runQueuedSteps(created.id, "needs_human")
        expect(parked.state).toBe("needs_human")
        expect(mergeCalls).toBe(0)

        const resumed = yield* lifecycle.continueAfterHumanPrOutcome(
          created.id,
          "merged",
        )
        expect(resumed.state).toBe("close_issue")
        expect(resumed.completionSummary).toBe(LINEAR_MERGE_COMPLETION_SUMMARY)
        expect(mergeCalls).toBe(0)

        const finished = yield* runQueuedSteps(created.id)
        return { created, finished }
      }).pipe(
        Effect.provide(
          linearLifecycleLayer(
            {
              ...successfulSteps,
              decidePrMerge: () =>
                Effect.succeed({
                  _tag: "needs_human" as const,
                  reason: "Repository merge policy requires a human merge",
                }),
              mergePr: () => {
                mergeCalls += 1
                return Effect.die("merge must not run after human merge")
              },
              closeIssue,
            },
            {
              issue: {
                id: linearNativeId,
                identifier: "ENG-123",
                url: "https://linear.app/acme/issue/ENG-123",
                teamId: linearWorkflow.teamId,
                teamKey: linearWorkflow.teamKey,
                stateId: "todo",
                stateName: "Todo",
                stateType: "unstarted",
              },
              updateIssueState: (_id, stateId) =>
                Effect.sync(() => {
                  states.push(stateId)
                }),
              ensureMilestoneComment: (_id, marker, body) =>
                Effect.sync(() => {
                  comments.push({ marker, body })
                }),
            },
          ),
        ),
      ),
    )

    expect(result.finished.state).toBe("complete")
    expect(states).toEqual(["done"])
    const completionComments = comments.filter((comment) =>
      comment.marker.includes("completion"),
    )
    expect(completionComments).toHaveLength(1)
    expect(completionComments[0]?.marker).toBe(
      linearMilestoneMarker("completion", result.created.id),
    )
    expect(completionComments[0]?.body).toContain(
      LINEAR_MERGE_COMPLETION_SUMMARY,
    )
    expect(
      result.finished.stepRuns.some((run) => run.step === "merge_pr"),
    ).toBe(false)
  })

  it("retries only Linear close-out after a confirmed merge when Linear fails", async () => {
    const states: string[] = []
    const comments: string[] = []
    let mergeCalls = 0
    let createPrCalls = 0
    let closeAttempts = 0
    const finished = await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* seedLinearMergeRepository(
          "/repos/acme/widgets-linear-merge-retry.git",
        )
        const created = yield* lifecycle.implementNow(repo.id, linearNativeId)
        const afterFailure = yield* runQueuedSteps(created.id)
        expect(afterFailure.state).toBe("close_issue")
        expect(afterFailure.state).not.toBe("complete")
        expect(mergeCalls).toBe(1)
        expect(createPrCalls).toBe(1)
        expect(closeAttempts).toBe(1)
        expect(states).toEqual([])
        expect(
          afterFailure.stepRuns.some(
            (run) => run.step === "close_issue" && run.status === "failed",
          ),
        ).toBe(true)

        const retried = yield* lifecycle.retry(created.id)
        return yield* runQueuedSteps(retried.id)
      }).pipe(
        Effect.provide(
          linearLifecycleLayer(
            {
              ...successfulSteps,
              createPr: () => {
                createPrCalls += 1
                return successfulSteps.createPr({} as never)
              },
              mergePr: () => {
                mergeCalls += 1
                return Effect.succeed({ _tag: "merged" as const })
              },
              closeIssue: (context) => {
                closeAttempts += 1
                if (closeAttempts === 1) {
                  return Effect.fail(
                    new LinearRequestError({
                      message: "Linear comment API unavailable",
                    }),
                  )
                }
                return closeIssue(context)
              },
            },
            {
              issue: {
                id: linearNativeId,
                identifier: "ENG-123",
                url: "https://linear.app/acme/issue/ENG-123",
                teamId: linearWorkflow.teamId,
                teamKey: linearWorkflow.teamKey,
                stateId: "todo",
                stateName: "Todo",
                stateType: "unstarted",
              },
              updateIssueState: () =>
                Effect.sync(() => {
                  states.push("done")
                }),
              ensureMilestoneComment: (_id, marker) =>
                Effect.sync(() => {
                  comments.push(marker)
                }),
            },
          ),
        ),
      ),
    )

    expect(finished.state).toBe("complete")
    expect(mergeCalls).toBe(1)
    expect(createPrCalls).toBe(1)
    expect(closeAttempts).toBe(2)
    expect(states).toEqual(["done"])
    expect(comments).toHaveLength(1)
    expect(
      finished.stepRuns.filter((run) => run.step === "merge_pr"),
    ).toHaveLength(1)
  })
})
