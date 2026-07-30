import { Effect, Layer } from "effect"
import type {
  MergePullRequestResult,
  PullRequestCheckStatus,
  PullRequestLifecycleStatus,
} from "@ready-for-agent/github-service"
import { GitLabProjectUnavailableError, GitLabRequestError } from "./errors.js"
import { GitLabService } from "./gitlab-service.js"
import type { GitLabReadyLabeledIssue, GitLabRepository } from "./types.js"

export interface GitLabServiceTestFixture {
  readonly repository: GitLabRepository
  readonly issues?: readonly GitLabReadyLabeledIssue[]
  readonly operatorLogin?: string
  readonly openPullRequestByBranch?: Readonly<Record<string, number>>
  readonly openNonDraftPullRequestCount?: number
  readonly pullRequestCheckStatus?: PullRequestCheckStatus
  readonly pullRequestLifecycleStatus?: PullRequestLifecycleStatus
  readonly mergePullRequestResult?: MergePullRequestResult
  readonly error?: GitLabRequestError
}

const key = (repository: GitLabRepository): string =>
  `${repository.forgeHost.toLowerCase()}/${repository.projectPath.toLowerCase()}`

export const makeGitLabServiceTest = (
  fixtures: readonly GitLabServiceTestFixture[],
): Layer.Layer<GitLabService> => {
  const byRepository = new Map(
    fixtures.map((fixture) => [key(fixture.repository), fixture]),
  )
  const fixtureFor = (repository: GitLabRepository) =>
    byRepository.get(key(repository))

  const failOr = <A>(
    repository: GitLabRepository,
    succeed: (fixture: GitLabServiceTestFixture) => Effect.Effect<A, never>,
  ) => {
    const fixture = fixtureFor(repository)
    if (fixture === undefined) {
      return Effect.fail(new GitLabProjectUnavailableError(repository))
    }
    if (fixture.error !== undefined) return Effect.fail(fixture.error)
    return succeed(fixture)
  }

  return Layer.succeed(GitLabService, {
    verifyProject: (repository) =>
      failOr(repository, (fixture) => Effect.succeed(fixture.repository)),
    getAuthenticatedUserLogin: (repository) =>
      failOr(repository, (fixture) =>
        Effect.succeed(fixture.operatorLogin ?? "operator"),
      ),
    listReadyIssues: (repository) =>
      failOr(repository, (fixture) =>
        Effect.succeed(
          [...(fixture.issues ?? [])].sort(
            (left, right) => left.number - right.number,
          ),
        ),
      ),
    hasCredentials: (repository) =>
      Effect.succeed(fixtureFor(repository) !== undefined),
    hasAmbientCredentials: (repository) =>
      Effect.succeed(fixtureFor(repository) !== undefined),
    getOpenPullRequestNumber: (repository, headRefName) => {
      const fixture = fixtureFor(repository)
      if (fixture === undefined) {
        return Effect.fail(new GitLabProjectUnavailableError(repository))
      }
      if (fixture.error !== undefined) return Effect.fail(fixture.error)
      const number = fixture.openPullRequestByBranch?.[headRefName]
      if (number === undefined) {
        return Effect.fail(
          new GitLabRequestError({
            message: `No open merge request found for ${repository.projectPath}:${headRefName}`,
          }),
        )
      }
      return Effect.succeed(number)
    },
    findOpenPullRequestNumber: (repository, headRefName) =>
      failOr(repository, (fixture) =>
        Effect.succeed(fixture.openPullRequestByBranch?.[headRefName] ?? null),
      ),
    createDraftPullRequest: (repository) =>
      failOr(repository, () => Effect.succeed(1)),
    updateOpenDraftPullRequestCopy: (repository, headRefName) =>
      failOr(repository, (fixture) =>
        Effect.succeed(fixture.openPullRequestByBranch?.[headRefName] ?? null),
      ),
    countOpenNonDraftPullRequests: (repository) =>
      failOr(repository, (fixture) =>
        Effect.succeed(fixture.openNonDraftPullRequestCount ?? 0),
      ),
    getPullRequestCheckStatus: (repository) =>
      failOr(repository, (fixture) =>
        Effect.succeed(
          fixture.pullRequestCheckStatus ?? {
            _tag: "succeeded" as const,
            terminalChecks: [],
            mergeability: "mergeable" as const,
            baseRefName: "main",
            headPushedAt: null,
            headSha: null,
            createdAt: null,
            isDraft: null,
          },
        ),
      ),
    getPrStatusCheckDiagnostics: (repository) =>
      failOr(repository, () => Effect.succeed([])),
    markPullRequestReadyForReview: (repository) =>
      failOr(repository, () => Effect.void),
    getPullRequestLifecycleStatus: (repository) =>
      failOr(repository, (fixture) =>
        Effect.succeed(
          fixture.pullRequestLifecycleStatus ??
            ({ _tag: "open" } satisfies PullRequestLifecycleStatus),
        ),
      ),
    mergePullRequest: (repository) =>
      failOr(repository, (fixture) =>
        Effect.succeed(
          fixture.mergePullRequestResult ??
            ({ _tag: "merged" } satisfies MergePullRequestResult),
        ),
      ),
    ensureIssueCompletedWithSummary: (repository) =>
      failOr(repository, () => Effect.void),
    closeOpenPullRequestsForBranch: (repository) =>
      failOr(repository, () => Effect.void),
    deleteBranch: (repository) => failOr(repository, () => Effect.void),
  })
}
