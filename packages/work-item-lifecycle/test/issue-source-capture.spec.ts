import { Effect, Layer } from "effect"
import {
  AGENT_BACKEND_IDS,
  type ActiveAgentBackend,
} from "@ready-for-agent/agent-backend"
import { DatabaseTest } from "@ready-for-agent/db/test"
import {
  DbService,
  DbServiceLive,
  type DbServiceShape,
} from "@ready-for-agent/db-service"
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

const storeOpenLeafIssue = (
  db: Pick<DbServiceShape, "storeIssue">,
  repositoryId: string,
  issueNumber: number,
  url: string,
) =>
  db.storeIssue({
    repositoryId,
    issueNumber,
    title: `Issue ${issueNumber}`,
    body: "body",
    url,
    state: "OPEN",
    githubCreatedAt: new Date(),
    issueAuthor: null,
    parent: null,
    parentPosition: null,
    hasChildren: false,
    blockedBy: [],
  })

const lifecycleLayer = (active: Layer.Layer<ActiveAgentBackend>) =>
  WorkItemLifecycleLive.pipe(
    Layer.provideMerge(active),
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
  )

describe("Original Issue Source capture", () => {
  it("captures the Repository Issue Tracker and live Issue identity on Implement Now", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          forge: "gitlab",
          forgeHost: "git.drupalcode.org",
          projectPath: "project/oauth_client",
          localPath: "/repos/gitlab/oauth_client.git",
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
        const url = "https://git.drupalcode.org/project/oauth_client/-/issues/9"
        yield* storeOpenLeafIssue(db, repo.id, 9, url)
        const created = yield* lifecycle.implementNow(repo.id, "9")
        expect(created.issueNumber).toBe(9)
        expect(created.issueSource).toEqual({
          tracker: "gitlab",
          nativeId: "9",
          displayId: "9",
          url,
        })
        expect(repo.issueTracker).toBe("gitlab")
        expect(repo.forge).toBe("gitlab")
      }).pipe(Effect.provide(lifecycleLayer(stubActiveAgentBackendLayer()))),
    )
  })

  it("captures Linear native identity and display key instead of the team number", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets-linear.git",
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
          linearWorkflowStatuses: [
            {
              teamId: "team-eng",
              teamKey: "ENG",
              teamName: "Engineering",
              inProgressStateId: "progress",
              inProgressStateName: "In Progress",
              doneStateId: "done",
              doneStateName: "Done",
            },
          ],
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
        const nativeId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        const url = "https://linear.app/acme/issue/ENG-123"
        yield* db.storeIssue({
          repositoryId: repo.id,
          issueNumber: 123,
          issueTracker: "github",
          nativeId: "123",
          displayId: "123",
          title: "GitHub leftover",
          body: "Wrong issue.",
          url: "https://github.com/acme/widgets/issues/123",
          state: "OPEN",
          githubCreatedAt: new Date(),
          issueAuthor: null,
          parent: null,
          parentPosition: null,
          hasChildren: false,
          blockedBy: [],
        })
        yield* db.storeIssue({
          repositoryId: repo.id,
          issueNumber: 123,
          issueTracker: "linear",
          nativeId,
          displayId: "ENG-123",
          title: "Ship Linear execution",
          body: "Implement in GitHub.",
          url,
          state: "OPEN",
          githubCreatedAt: new Date(),
          issueAuthor: null,
          parent: null,
          parentPosition: null,
          hasChildren: false,
          blockedBy: [],
        })
        const created = yield* lifecycle.implementNow(repo.id, nativeId)
        expect(created.issueNumber).toBe(123)
        expect(created.issueSource).toEqual({
          tracker: "linear",
          nativeId,
          displayId: "ENG-123",
          url,
        })
      }).pipe(Effect.provide(lifecycleLayer(stubActiveAgentBackendLayer()))),
    )
  })

  it("starts distinct Linear leaves that share a team-local number", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets-linear-ambiguous.git",
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
          linearWorkflowStatuses: [
            {
              teamId: "team-eng",
              teamKey: "ENG",
              teamName: "Engineering",
              inProgressStateId: "progress",
              inProgressStateName: "In Progress",
              doneStateId: "done",
              doneStateName: "Done",
            },
          ],
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
          nativeId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          displayId: "ENG-123",
          title: "Eng leaf",
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
        yield* db.storeIssue({
          repositoryId: repo.id,
          issueNumber: 123,
          issueTracker: "linear",
          nativeId: "b2c3d4e5-f6a7-8901-bcde-f12345678901",
          displayId: "DES-123",
          title: "Des leaf",
          body: "body",
          url: "https://linear.app/acme/issue/DES-123",
          state: "OPEN",
          githubCreatedAt: new Date(),
          issueAuthor: null,
          parent: null,
          parentPosition: null,
          hasChildren: false,
          blockedBy: [],
        })
        const created = yield* lifecycle.implementNow(
          repo.id,
          "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        )
        expect(created.issueSource).toEqual({
          tracker: "linear",
          nativeId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          displayId: "ENG-123",
          url: "https://linear.app/acme/issue/ENG-123",
        })
        const sibling = yield* lifecycle.implementNow(
          repo.id,
          "b2c3d4e5-f6a7-8901-bcde-f12345678901",
        )
        expect(sibling.issueSource.displayId).toBe("DES-123")
      }).pipe(Effect.provide(lifecycleLayer(stubActiveAgentBackendLayer()))),
    )
  })

  it("captures Original Issue Source on Queue without snapshotting live Issue content", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets-queue.git",
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
        const url = "https://github.com/acme/widgets/issues/11"
        yield* db.storeIssue({
          repositoryId: repo.id,
          issueNumber: 11,
          title: "Blocked leaf",
          body: "body",
          url,
          state: "OPEN",
          githubCreatedAt: new Date(),
          issueAuthor: null,
          parent: null,
          parentPosition: null,
          hasChildren: false,
          blockedBy: [
            {
              issueNumber: 2,
              issueUrl: "https://github.com/acme/widgets/issues/2",
            },
          ],
        })
        const created = yield* lifecycle.queue(repo.id, "11")
        expect(created.issueNumber).toBe(11)
        expect(created.issueSource).toEqual({
          tracker: "github",
          nativeId: "11",
          displayId: "11",
          url,
        })
        expect(created.issueTitle).toBe("Blocked leaf")
      }).pipe(Effect.provide(lifecycleLayer(stubActiveAgentBackendLayer()))),
    )
  })
})
