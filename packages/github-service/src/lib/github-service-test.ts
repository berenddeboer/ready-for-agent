import { Effect, Layer } from "effect"
import {
  GitHubRepositoryUnavailableError,
  type GitHubRequestError,
} from "./errors.js"
import { GitHubService, type GitHubServiceShape } from "./github-service.js"
import type { GitHubRepository, ReadyLabeledIssue } from "./types.js"

const TEST_USER_ATTACHMENT_URL =
  "https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000001"

interface GitHubServiceTestFixtureBase {
  readonly repository: GitHubRepository
}

export interface GitHubServiceTestIssuesFixture
  extends GitHubServiceTestFixtureBase {
  readonly issues: readonly ReadyLabeledIssue[]
  readonly error?: never
}

export interface GitHubServiceTestErrorFixture
  extends GitHubServiceTestFixtureBase {
  readonly error: GitHubRequestError
  readonly issues?: never
}

export type GitHubServiceTestFixture =
  | GitHubServiceTestIssuesFixture
  | GitHubServiceTestErrorFixture

const repositoryKey = ({ forge, forgeHost, projectPath }: GitHubRepository) =>
  `${forge.toLowerCase()}/${forgeHost.toLowerCase()}/${projectPath.toLowerCase()}`

export const makeGitHubServiceTest = (
  fixtures: readonly GitHubServiceTestFixture[],
  options: {
    readonly uploadUserAttachment?: GitHubServiceShape["uploadUserAttachment"]
  } = {},
): Layer.Layer<GitHubService> => {
  const fixturesByRepository = new Map(
    fixtures.map((fixture) => [repositoryKey(fixture.repository), fixture]),
  )

  return Layer.succeed(GitHubService, {
    getAuthenticatedUserLogin: () => Effect.succeed("test-operator"),
    getOpenPullRequestNumber: () => Effect.succeed(1),
    findOpenPullRequestNumber: () => Effect.succeed(1),
    closeOpenPullRequestsAndDeleteBranch: () => Effect.void,
    countOpenNonDraftPullRequests: () => Effect.succeed(0),
    createDraftPullRequest: () => Effect.succeed(1),
    updateOpenDraftPullRequestCopy: () => Effect.succeed(1),
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
    getPullRequestLifecycleStatus: () => Effect.succeed({ _tag: "open" }),
    markPullRequestReadyForReview: () => Effect.void,
    mergePullRequest: () => Effect.succeed({ _tag: "merged" }),
    rerunWorkflowRun: () => Effect.void,
    uploadUserAttachment:
      options.uploadUserAttachment ??
      (() => Effect.succeed(TEST_USER_ATTACHMENT_URL)),
    ensureIssueCompletedWithSummary: () => Effect.void,
    listReadyIssues: (repository) => {
      const fixture = fixturesByRepository.get(repositoryKey(repository))
      if (fixture === undefined) {
        return Effect.fail(new GitHubRepositoryUnavailableError(repository))
      }
      if (fixture.error !== undefined) {
        return Effect.fail(fixture.error)
      }

      return Effect.succeed(
        [...fixture.issues].sort((left, right) => left.number - right.number),
      )
    },
  })
}
