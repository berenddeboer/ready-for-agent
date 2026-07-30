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
import type { LifecycleStepContext } from "../src/index.js"
import {
  CloseIssueContextError,
  CloseIssueEligibilityError,
  CloseIssueSummaryMissingError,
  closeIssue,
  makeWorkItemId,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const repository = makeRepositoryRecord({ localPath: "/repos/widgets" })

const openLeaf = {
  repositoryId: repository.id,
  issueNumber: 42,
  title: "Leaf",
  body: "body",
  url: "https://github.com/acme/widgets/issues/42",
  state: "OPEN" as const,
  githubCreatedAt: new Date("2026-01-15T12:00:00.000Z"),
  parent: null,
  parentPosition: null,
  hasChildren: false,
  blockedBy: [] as const,
}

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
  startingCommitOid: "abc123",
  completionSummary: "Findings complete.",

  publicationTitle: null,

  publicationBody: null,
  sessionId: "ses_implement",
}

const unusedGithub = {
  getAuthenticatedUserLogin: () => Effect.succeed("test-operator"),
  listReadyIssues: () => Effect.succeed([]),
  getOpenPullRequestNumber: () => Effect.succeed(1),
  findOpenPullRequestNumber: () => Effect.succeed(1),
  createDraftPullRequest: () => Effect.succeed(1),
  countOpenNonDraftPullRequests: () => Effect.succeed(0),
  getPullRequestCheckStatus: () =>
    Effect.succeed({
      _tag: "succeeded" as const,
      terminalChecks: [],
      mergeability: "mergeable" as const,
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
  ensureIssueCompletedWithSummary: () => Effect.void,
} satisfies GitHubServiceShape

describe("closeIssue", () => {
  it("fails when the completion summary is missing", async () => {
    const error = await Effect.runPromise(
      closeIssue({ ...context, completionSummary: null }).pipe(Effect.flip),
    )
    expect(error).toBeInstanceOf(CloseIssueSummaryMissingError)
  })

  it("fails when the repository is missing", async () => {
    const db = stubDbServiceLayer({
      listRepositories: Effect.succeed([]),
      listIssues: () => Effect.succeed([openLeaf]),
    })
    const github = Layer.succeed(GitHubService, unusedGithub)
    const error = await Effect.runPromise(
      closeIssue(context).pipe(
        Effect.provide(Layer.merge(db, github)),
        Effect.flip,
      ),
    )
    expect(error).toBeInstanceOf(CloseIssueContextError)
  })

  it("closes a GitLab Issue via GitLabService without calling GitHub", async () => {
    const gitlabRepository = makeRepositoryRecord({
      forge: "gitlab",
      forgeHost: "git.drupalcode.org",
      projectPath: "project/widgets",
      localPath: "/repos/project-widgets",
    })
    const db = stubDbServiceLayer({
      listRepositories: Effect.succeed([gitlabRepository]),
      listIssues: () =>
        Effect.succeed([
          {
            ...openLeaf,
            repositoryId: gitlabRepository.id,
            url: "https://git.drupalcode.org/project/widgets/-/issues/42",
          },
        ]),
    })
    let githubCalls = 0
    const calls: Array<{
      issueNumber: number
      workItemId: string
      summary: string
      projectPath: string
    }> = []
    const github = Layer.succeed(GitHubService, {
      ...unusedGithub,
      ensureIssueCompletedWithSummary: () => {
        githubCalls += 1
        return Effect.void
      },
    } satisfies GitHubServiceShape)
    const gitlab = Layer.succeed(GitLabService, {
      verifyProject: (repository) => Effect.succeed(repository),
      getAuthenticatedUserLogin: () => Effect.succeed("operator"),
      listReadyIssues: () => Effect.succeed([]),
      hasCredentials: () => Effect.succeed(true),
      hasAmbientCredentials: () => Effect.succeed(true),
      getOpenPullRequestNumber: () => Effect.succeed(1),
      findOpenPullRequestNumber: () => Effect.succeed(null),
      createDraftPullRequest: () => Effect.succeed(1),
      updateOpenDraftPullRequestCopy: () => Effect.succeed(null),
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
      markPullRequestReadyForReview: () => Effect.void,
      getPullRequestLifecycleStatus: () =>
        Effect.succeed({ _tag: "open" as const }),
      mergePullRequest: () => Effect.succeed({ _tag: "merged" as const }),
      ensureIssueCompletedWithSummary: (
        repository,
        issueNumber,
        workItemId,
        summaryMarkdown,
      ) =>
        Effect.sync(() => {
          calls.push({
            issueNumber,
            workItemId,
            summary: summaryMarkdown,
            projectPath: repository.projectPath,
          })
        }),
      closeOpenPullRequestsForBranch: () => Effect.void,
      deleteBranch: () => Effect.void,
    } satisfies GitLabServiceShape)

    await Effect.runPromise(
      closeIssue({
        ...context,
        repositoryId: gitlabRepository.id,
      }).pipe(Effect.provide(Layer.mergeAll(db, github, gitlab))),
    )

    expect(githubCalls).toBe(0)
    expect(calls).toEqual([
      {
        issueNumber: 42,
        workItemId: context.workItemId,
        summary: "Findings complete.",
        projectPath: "project/widgets",
      },
    ])
  })

  it("rejects an open parent Issue before mutation", async () => {
    const db = stubDbServiceLayer({
      listRepositories: Effect.succeed([repository]),
      listIssues: () => Effect.succeed([{ ...openLeaf, hasChildren: true }]),
    })
    let called = false
    const github = Layer.succeed(GitHubService, {
      ...unusedGithub,
      ensureIssueCompletedWithSummary: () => {
        called = true
        return Effect.void
      },
    } satisfies GitHubServiceShape)
    const error = await Effect.runPromise(
      closeIssue(context).pipe(
        Effect.provide(Layer.merge(db, github)),
        Effect.flip,
      ),
    )
    expect(error).toBeInstanceOf(CloseIssueEligibilityError)
    expect(called).toBe(false)
  })

  it("rejects an open blocked Issue before mutation", async () => {
    const db = stubDbServiceLayer({
      listRepositories: Effect.succeed([repository]),
      listIssues: () =>
        Effect.succeed([
          {
            ...openLeaf,
            blockedBy: [
              {
                issueNumber: 1,
                issueUrl: "https://github.com/acme/widgets/issues/1",
              },
            ],
          },
        ]),
    })
    let called = false
    const github = Layer.succeed(GitHubService, {
      ...unusedGithub,
      ensureIssueCompletedWithSummary: () => {
        called = true
        return Effect.void
      },
    } satisfies GitHubServiceShape)
    const error = await Effect.runPromise(
      closeIssue(context).pipe(
        Effect.provide(Layer.merge(db, github)),
        Effect.flip,
      ),
    )
    expect(error).toBeInstanceOf(CloseIssueEligibilityError)
    expect(called).toBe(false)
  })

  it("accepts an already-closed Issue and still ensures the summary", async () => {
    const db = stubDbServiceLayer({
      listRepositories: Effect.succeed([repository]),
      listIssues: () =>
        Effect.succeed([{ ...openLeaf, state: "CLOSED" as const }]),
    })
    const calls: Array<{
      issueNumber: number
      workItemId: string
      summary: string
    }> = []
    const github = Layer.succeed(GitHubService, {
      ...unusedGithub,
      ensureIssueCompletedWithSummary: (
        _repo,
        issueNumber,
        workItemId,
        summaryMarkdown,
      ) =>
        Effect.sync(() => {
          calls.push({
            issueNumber,
            workItemId,
            summary: summaryMarkdown,
          })
        }),
    } satisfies GitHubServiceShape)
    await Effect.runPromise(
      closeIssue(context).pipe(Effect.provide(Layer.merge(db, github))),
    )
    expect(calls).toEqual([
      {
        issueNumber: 42,
        workItemId: context.workItemId,
        summary: "Findings complete.",
      },
    ])
  })

  it("closes an open Leaf Issue with the persisted summary", async () => {
    const db = stubDbServiceLayer({
      listRepositories: Effect.succeed([repository]),
      listIssues: () => Effect.succeed([openLeaf]),
    })
    const calls: string[] = []
    const github = Layer.succeed(GitHubService, {
      ...unusedGithub,
      ensureIssueCompletedWithSummary: (
        _repo,
        _issueNumber,
        _workItemId,
        summaryMarkdown,
      ) =>
        Effect.sync(() => {
          calls.push(summaryMarkdown)
        }),
    } satisfies GitHubServiceShape)
    await Effect.runPromise(
      closeIssue(context).pipe(Effect.provide(Layer.merge(db, github))),
    )
    expect(calls).toEqual(["Findings complete."])
  })
})
