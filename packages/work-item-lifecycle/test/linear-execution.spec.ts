import { Effect, Layer } from "effect"
import { AGENT_BACKEND_IDS } from "@ready-for-agent/agent-backend"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import {
  LinearRequestError,
  linearMilestoneMarker,
} from "@ready-for-agent/linear-service"
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
        const githubWork = yield* lifecycle.implementNow(repo.id, 17)
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
        const linearWork = yield* lifecycle.implementNow(repo.id, 123)
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
        const created = yield* lifecycle.implementNow(repo.id, 123)
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
        const created = yield* lifecycle.implementNow(repo.id, 123)
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
        const created = yield* lifecycle.implementNow(repo.id, 123)
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
})
