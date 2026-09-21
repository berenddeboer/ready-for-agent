import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { AGENT_BACKEND_IDS } from "@ready-for-agent/agent-backend"
import { DatabaseTest } from "@ready-for-agent/db/test"
import {
  DbService,
  DbServiceLive,
  type DbServiceShape,
} from "@ready-for-agent/db-service"
import { forgeIssueSource } from "@ready-for-agent/lifecycle-model"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
  LifecycleSteps,
  type LifecycleStepsShape,
  WorkItemLifecycle,
  WorkItemLifecycleLive,
  closeIssue,
  issueOperationsForge,
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

describe("Original Issue Source execution", () => {
  it("prefers captured Original Issue Source over the Repository hosting Forge", () => {
    const githubSource = forgeIssueSource({
      tracker: "github",
      issueNumber: 17,
      url: "https://github.com/acme/widgets/issues/17",
    })
    expect(issueOperationsForge(undefined, "github")).toBe("github")
    expect(issueOperationsForge(githubSource, "gitlab")).toBe("github")
    expect(
      issueOperationsForge(
        {
          tracker: "linear",
          nativeId: "uuid",
          displayId: "ENG-1",
          url: "https://linear.app/acme/issue/ENG-1",
        },
        "github",
      ),
    ).toBeNull()
  })

  it("keeps issue operations on the captured source after the Repository tracker changes", async () => {
    const githubCompletions: Array<{
      readonly forge: string
      readonly issueNumber: number
    }> = []
    let gitlabCompletions = 0

    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const sql = yield* SqlClient.SqlClient
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets-source.git",
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
        const url = "https://github.com/acme/widgets/issues/17"
        yield* storeOpenLeafIssue(db, repo.id, 17, url)
        const created = yield* lifecycle.implementNow(repo.id, "17")
        expect(created.issueSource).toEqual({
          tracker: "github",
          nativeId: "17",
          displayId: "17",
          url,
        })

        yield* sql.unsafe(
          `UPDATE repository SET issue_tracker = 'linear' WHERE id = ?`,
          [repo.id],
        )
        const switched = (yield* db.listRepositories).find(
          (candidate) => candidate.id === repo.id,
        )
        expect(switched?.issueTracker).toBe("linear")
        expect(switched?.forge).toBe("github")

        const reloaded = yield* lifecycle.getWorkItem(created.id)
        expect(reloaded.issueSource).toEqual({
          tracker: "github",
          nativeId: "17",
          displayId: "17",
          url,
        })

        yield* closeIssue({
          workItemId: reloaded.id,
          repositoryId: reloaded.repositoryId,
          issueNumber: reloaded.issueNumber,
          issueSource: reloaded.issueSource,
          issueTitle: reloaded.issueTitle,
          agentBackend: reloaded.agentBackend,
          model: "opencode/test-model",
          thinkingLevel: "high",
          reviewModel: "opencode/test-model",
          reviewThinkingLevel: "high",
          worktreePath: reloaded.worktreePath,
          startingCommitOid: reloaded.startingCommitOid,
          completionSummary: "Findings complete.",
          publicationTitle: reloaded.publicationTitle,
          publicationBody: reloaded.publicationBody,
          sessionId: reloaded.sessionId,
        })
      }).pipe(
        Effect.provide(
          WorkItemLifecycleLive.pipe(
            Layer.provideMerge(stubActiveAgentBackendLayer()),
            Layer.provideMerge(
              stubGitHubServiceLayer({
                ensureIssueCompletedWithSummary: (repository, issueNumber) =>
                  Effect.sync(() => {
                    githubCompletions.push({
                      forge: repository.forge,
                      issueNumber,
                    })
                  }),
              }),
            ),
            Layer.provideMerge(
              stubGitLabServiceLayer({
                ensureIssueCompletedWithSummary: () => {
                  gitlabCompletions += 1
                  return Effect.void
                },
              }),
            ),
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

    expect(githubCompletions).toEqual([{ forge: "github", issueNumber: 17 }])
    expect(gitlabCompletions).toBe(0)
  })
})
