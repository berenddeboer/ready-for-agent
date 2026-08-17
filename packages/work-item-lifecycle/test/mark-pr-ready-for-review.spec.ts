import { Effect, Layer } from "effect"
import {
  makeRepositoryRecord,
  stubDbServiceLayer,
} from "@ready-for-agent/db-service/test"
import {
  GitHubService,
  type GitHubServiceShape,
} from "@ready-for-agent/github-service"
import {
  GitLabService,
  type GitLabServiceShape,
} from "@ready-for-agent/gitlab-service"
import {
  type LifecycleStepContext,
  makeWorkItemId,
  markPrReadyForReview,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const repository = makeRepositoryRecord({ localPath: "/repos/widgets" })

const context: LifecycleStepContext = {
  workItemId: makeWorkItemId(),
  repositoryId: repository.id,
  issueNumber: 42,
  issueTitle: null,
  agentBackend: "opencode",
  model: "opencode/test-model",
  thinkingLevel: "high",
  reviewModel: "opencode/test-model",
  reviewThinkingLevel: "high",
  worktreePath: "/tmp/worktree",
  startingCommitOid: null,
  completionSummary: null,

  publicationTitle: null,

  publicationBody: null,
  sessionId: "ses_implement",
}

const db = stubDbServiceLayer({
  listRepositories: Effect.succeed([repository]),
})

describe("markPrReadyForReview", () => {
  it("marks the deterministic Work Item branch PR ready for review", async () => {
    let requestedBranch = ""
    const github = Layer.succeed(GitHubService, {
      getAuthenticatedUserLogin: () => Effect.succeed("test-operator"),
      listReadyIssues: () => Effect.succeed([]),
      getOpenPullRequestNumber: () => Effect.succeed(1),
      findOpenPullRequestNumber: () => Effect.succeed(1),
      createDraftPullRequest: () => Effect.succeed(1),
      countOpenNonDraftPullRequests: () => Effect.succeed(0),
      getPullRequestCheckStatus: () =>
        Effect.succeed({
          _tag: "succeeded",
          terminalChecks: [],
          mergeability: "mergeable",
          baseRefName: "main",
          headPushedAt: null,
          headSha: null,
          createdAt: null,
          isDraft: null,
        }),
      getPrStatusCheckDiagnostics: () => Effect.succeed([]),
      observeAutomatedReviewEvidence: () =>
        Effect.succeed({
          _tag: "ambiguous" as const,
          reason: "Automated review evidence observation is not configured",
        }),
      getPullRequestLifecycleStatus: () =>
        Effect.succeed({ _tag: "open" as const }),
      markPullRequestReadyForReview: (_repository, branch) => {
        requestedBranch = branch
        return Effect.void
      },
      mergePullRequest: () => Effect.succeed({ _tag: "merged" }),
      rerunWorkflowRun: () => Effect.void,
      uploadUserAttachment: () =>
        Effect.succeed(
          "https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000001",
        ),
      ensureIssueCompletedWithSummary: () => Effect.void,
    } satisfies GitHubServiceShape)

    await Effect.runPromise(
      markPrReadyForReview(context).pipe(
        Effect.provide(Layer.merge(db, github)),
      ),
    )

    expect(requestedBranch).toBe(`rfa/acme-widgets/42/${context.workItemId}`)
  })

  it("requires a worktree path", async () => {
    const github = Layer.succeed(GitHubService, {
      getAuthenticatedUserLogin: () => Effect.succeed("test-operator"),
      listReadyIssues: () => Effect.succeed([]),
      getOpenPullRequestNumber: () => Effect.succeed(1),
      findOpenPullRequestNumber: () => Effect.succeed(1),
      createDraftPullRequest: () => Effect.succeed(1),
      countOpenNonDraftPullRequests: () => Effect.succeed(0),
      getPullRequestCheckStatus: () =>
        Effect.succeed({
          _tag: "succeeded",
          terminalChecks: [],
          mergeability: "mergeable",
          baseRefName: "main",
          headPushedAt: null,
          headSha: null,
          createdAt: null,
          isDraft: null,
        }),
      getPrStatusCheckDiagnostics: () => Effect.succeed([]),
      observeAutomatedReviewEvidence: () =>
        Effect.succeed({
          _tag: "ambiguous" as const,
          reason: "Automated review evidence observation is not configured",
        }),
      getPullRequestLifecycleStatus: () =>
        Effect.succeed({ _tag: "open" as const }),
      markPullRequestReadyForReview: () => Effect.void,
      mergePullRequest: () => Effect.succeed({ _tag: "merged" }),
      rerunWorkflowRun: () => Effect.void,
      uploadUserAttachment: () =>
        Effect.succeed(
          "https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000001",
        ),
      ensureIssueCompletedWithSummary: () => Effect.void,
    } satisfies GitHubServiceShape)

    const exit = await Effect.runPromise(
      Effect.exit(
        markPrReadyForReview({ ...context, worktreePath: null }).pipe(
          Effect.provide(Layer.merge(db, github)),
        ),
      ),
    )

    expect(exit._tag).toBe("Failure")
  })

  it("marks a GitLab draft MR ready for review without querying GitHub", async () => {
    let githubCalls = 0
    let gitlabBranch = ""
    const gitlabRepository = makeRepositoryRecord({
      id: repository.id,
      forge: "gitlab",
      forgeHost: "git.drupalcode.org",
      projectPath: "project/widgets",
      localPath: "/repos/widgets",
    })
    const gitlabDb = stubDbServiceLayer({
      listRepositories: Effect.succeed([gitlabRepository]),
    })
    const github = Layer.succeed(GitHubService, {
      markPullRequestReadyForReview: () => {
        githubCalls += 1
        return Effect.void
      },
    } as GitHubServiceShape)
    const gitlab = Layer.succeed(GitLabService, {
      markPullRequestReadyForReview: (_repository, branch) => {
        gitlabBranch = branch
        return Effect.void
      },
    } as GitLabServiceShape)

    await Effect.runPromise(
      markPrReadyForReview(context).pipe(
        Effect.provide(Layer.mergeAll(gitlabDb, github, gitlab)),
      ),
    )

    expect(githubCalls).toBe(0)
    expect(gitlabBranch).toBe(`rfa/project-widgets/42/${context.workItemId}`)
  })
})
