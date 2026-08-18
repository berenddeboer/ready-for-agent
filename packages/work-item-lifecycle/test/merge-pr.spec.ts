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
  mergePr,
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

describe("mergePr", () => {
  it("merges the deterministic Work Item branch PR", async () => {
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
      markPullRequestReadyForReview: () => Effect.void,
      mergePullRequest: (_repository, branch, options) => {
        requestedBranch = branch
        expect(options).toBeUndefined()
        return Effect.succeed({ _tag: "merged" as const })
      },
      uploadUserAttachment: () =>
        Effect.succeed(
          "https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000001",
        ),
      ensureIssueCompletedWithSummary: () => Effect.void,
    } satisfies GitHubServiceShape)

    await Effect.runPromise(
      mergePr(context).pipe(Effect.provide(Layer.merge(db, github))),
    )

    expect(requestedBranch).toBe(`rfa/acme-widgets/42/${context.workItemId}`)
  })

  it("asks GitHub to accept no_checks only for Always", async () => {
    let seenOptions: { readonly acceptNoChecks?: boolean } | undefined
    const github = Layer.succeed(GitHubService, {
      mergePullRequest: (_repository, _branch, options) => {
        seenOptions = options
        return Effect.succeed({ _tag: "merged" as const })
      },
    } as GitHubServiceShape)

    await Effect.runPromise(
      mergePr({ ...context, mergeMode: "always" }).pipe(
        Effect.provide(Layer.merge(db, github)),
      ),
    )

    expect(seenOptions).toEqual({ acceptNoChecks: true })
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
        mergePr({ ...context, worktreePath: null }).pipe(
          Effect.provide(Layer.merge(db, github)),
        ),
      ),
    )

    expect(exit._tag).toBe("Failure")
  })

  it("merges the deterministic Work Item branch MR for GitLab", async () => {
    let requestedBranch = ""
    let githubCalls = 0
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
      mergePullRequest: () => {
        githubCalls += 1
        return Effect.succeed({ _tag: "merged" as const })
      },
    } as GitHubServiceShape)
    const gitlab = Layer.succeed(GitLabService, {
      mergePullRequest: (_repository, branch, options) => {
        requestedBranch = branch
        expect(options).toBeUndefined()
        return Effect.succeed({ _tag: "merged" as const })
      },
    } as GitLabServiceShape)

    await Effect.runPromise(
      mergePr(context).pipe(
        Effect.provide(Layer.mergeAll(gitlabDb, github, gitlab)),
      ),
    )

    expect(requestedBranch).toBe(`rfa/project-widgets/42/${context.workItemId}`)
    expect(githubCalls).toBe(0)
  })

  it("asks GitLab to accept no_checks only for Always", async () => {
    let seenOptions: { readonly acceptNoChecks?: boolean } | undefined
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
      mergePullRequest: () => Effect.die("GitHub must not merge a GitLab repo"),
    } as GitHubServiceShape)
    const gitlab = Layer.succeed(GitLabService, {
      mergePullRequest: (_repository, _branch, options) => {
        seenOptions = options
        return Effect.succeed({ _tag: "merged" as const })
      },
    } as GitLabServiceShape)

    await Effect.runPromise(
      mergePr({ ...context, mergeMode: "always" }).pipe(
        Effect.provide(Layer.mergeAll(gitlabDb, github, gitlab)),
      ),
    )

    expect(seenOptions).toEqual({ acceptNoChecks: true })
  })
})
