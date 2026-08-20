import { Effect, Layer } from "effect"
import { AzureDevOpsService } from "./azure-devops-service.js"
import {
  AzureDevOpsNotImplementedError,
  AzureDevOpsProjectUnavailableError,
  AzureDevOpsRequestError,
} from "./errors.js"
import type { AzureDevOpsRepository } from "./types.js"

/**
 * Hand-written fake for the nine Azure DevOps service methods implemented
 * against the real REST API today. Mirrors
 * `gitlab-service-test.ts`'s in-memory `Map`-keyed `Layer.succeed` pattern:
 * no HTTP mocking library. Every other method fails with
 * `AzureDevOpsNotImplementedError`, matching the live layer, so callers
 * exercising unimplemented methods against this fake see the same error they
 * would see against `AzureDevOpsServiceLive`.
 */
export interface AzureDevOpsServiceTestFixture {
  readonly repository: AzureDevOpsRepository
  readonly operatorLogin?: string
  readonly hasCredentials?: boolean
  /** Open pull request number keyed by exact source branch. */
  readonly openPullRequestByBranch?: Readonly<Record<string, number>>
  readonly error?: AzureDevOpsRequestError
}

const key = (repository: AzureDevOpsRepository): string =>
  repository.projectPath.toLowerCase()

/** Mutable per-Repository state so create/update/mark-ready observably change it. */
type FixtureState = {
  readonly fixture: AzureDevOpsServiceTestFixture
  readonly openPullRequestByBranch: Record<string, number>
  nextPullRequestNumber: number
}

export const makeAzureDevOpsServiceTest = (
  fixtures: readonly AzureDevOpsServiceTestFixture[],
): Layer.Layer<AzureDevOpsService> => {
  const byRepository = new Map<string, FixtureState>(
    fixtures.map((fixture) => [
      key(fixture.repository),
      {
        fixture,
        openPullRequestByBranch: { ...(fixture.openPullRequestByBranch ?? {}) },
        nextPullRequestNumber:
          1 +
          Math.max(0, ...Object.values(fixture.openPullRequestByBranch ?? {})),
      },
    ]),
  )
  const stateFor = (repository: AzureDevOpsRepository) =>
    byRepository.get(key(repository))

  const failOr = <A>(
    repository: AzureDevOpsRepository,
    succeed: (state: FixtureState) => Effect.Effect<A, never>,
  ) => {
    const state = stateFor(repository)
    if (state === undefined) {
      return Effect.fail(new AzureDevOpsProjectUnavailableError(repository))
    }
    if (state.fixture.error !== undefined) {
      return Effect.fail(state.fixture.error)
    }
    return succeed(state)
  }

  const notImplemented = (method: string) => () =>
    Effect.fail(new AzureDevOpsNotImplementedError({ method }))

  return Layer.succeed(AzureDevOpsService, {
    verifyProject: (repository) =>
      failOr(repository, (state) => Effect.succeed(state.fixture.repository)),
    getAuthenticatedUserLogin: (repository) =>
      failOr(repository, (state) =>
        Effect.succeed(state.fixture.operatorLogin ?? "operator"),
      ),
    hasCredentials: (repository) => {
      const state = stateFor(repository)
      return Effect.succeed(
        state !== undefined && (state.fixture.hasCredentials ?? true),
      )
    },
    hasAmbientCredentials: (repository) => {
      const state = stateFor(repository)
      return Effect.succeed(
        state !== undefined && (state.fixture.hasCredentials ?? true),
      )
    },
    listReadyIssues: notImplemented("listReadyIssues"),
    getOpenPullRequestNumber: (repository, headRefName) => {
      const state = stateFor(repository)
      if (state === undefined) {
        return Effect.fail(new AzureDevOpsProjectUnavailableError(repository))
      }
      if (state.fixture.error !== undefined) {
        return Effect.fail(state.fixture.error)
      }
      const number = state.openPullRequestByBranch[headRefName]
      if (number === undefined) {
        return Effect.fail(
          new AzureDevOpsRequestError({
            message: `No open pull request found for ${repository.projectPath}:${headRefName}`,
          }),
        )
      }
      return Effect.succeed(number)
    },
    findOpenPullRequestNumber: (repository, headRefName) =>
      failOr(repository, (state) =>
        Effect.succeed(state.openPullRequestByBranch[headRefName] ?? null),
      ),
    createDraftPullRequest: (repository, input) =>
      failOr(repository, (state) => {
        const pullRequestNumber = state.nextPullRequestNumber
        state.nextPullRequestNumber += 1
        state.openPullRequestByBranch[input.headRefName] = pullRequestNumber
        return Effect.succeed(pullRequestNumber)
      }),
    updateOpenDraftPullRequestCopy: (repository, headRefName) =>
      failOr(repository, (state) =>
        Effect.succeed(state.openPullRequestByBranch[headRefName] ?? null),
      ),
    countOpenNonDraftPullRequests: notImplemented(
      "countOpenNonDraftPullRequests",
    ),
    getPullRequestCheckStatus: notImplemented("getPullRequestCheckStatus"),
    getPrStatusCheckDiagnostics: notImplemented("getPrStatusCheckDiagnostics"),
    markPullRequestReadyForReview: (repository) =>
      failOr(repository, () => Effect.void),
    getPullRequestLifecycleStatus: notImplemented(
      "getPullRequestLifecycleStatus",
    ),
    mergePullRequest: notImplemented("mergePullRequest"),
    ensureIssueCompletedWithSummary: notImplemented(
      "ensureIssueCompletedWithSummary",
    ),
    closeOpenPullRequestsForBranch: notImplemented(
      "closeOpenPullRequestsForBranch",
    ),
    deleteBranch: notImplemented("deleteBranch"),
  })
}
