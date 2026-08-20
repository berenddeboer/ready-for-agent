import { Effect, Layer } from "effect"
import { AzureDevOpsService } from "./azure-devops-service.js"
import {
  AzureDevOpsNotImplementedError,
  AzureDevOpsProjectUnavailableError,
  type AzureDevOpsRequestError,
} from "./errors.js"
import type { AzureDevOpsRepository } from "./types.js"

/**
 * Hand-written fake for the four Azure DevOps service methods implemented
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
  readonly error?: AzureDevOpsRequestError
}

const key = (repository: AzureDevOpsRepository): string =>
  repository.projectPath.toLowerCase()

export const makeAzureDevOpsServiceTest = (
  fixtures: readonly AzureDevOpsServiceTestFixture[],
): Layer.Layer<AzureDevOpsService> => {
  const byRepository = new Map(
    fixtures.map((fixture) => [key(fixture.repository), fixture]),
  )
  const fixtureFor = (repository: AzureDevOpsRepository) =>
    byRepository.get(key(repository))

  const failOr = <A>(
    repository: AzureDevOpsRepository,
    succeed: (
      fixture: AzureDevOpsServiceTestFixture,
    ) => Effect.Effect<A, never>,
  ) => {
    const fixture = fixtureFor(repository)
    if (fixture === undefined) {
      return Effect.fail(new AzureDevOpsProjectUnavailableError(repository))
    }
    if (fixture.error !== undefined) return Effect.fail(fixture.error)
    return succeed(fixture)
  }

  const notImplemented = (method: string) => () =>
    Effect.fail(new AzureDevOpsNotImplementedError({ method }))

  return Layer.succeed(AzureDevOpsService, {
    verifyProject: (repository) =>
      failOr(repository, (fixture) => Effect.succeed(fixture.repository)),
    getAuthenticatedUserLogin: (repository) =>
      failOr(repository, (fixture) =>
        Effect.succeed(fixture.operatorLogin ?? "operator"),
      ),
    hasCredentials: (repository) => {
      const fixture = fixtureFor(repository)
      return Effect.succeed(
        fixture !== undefined && (fixture.hasCredentials ?? true),
      )
    },
    hasAmbientCredentials: (repository) => {
      const fixture = fixtureFor(repository)
      return Effect.succeed(
        fixture !== undefined && (fixture.hasCredentials ?? true),
      )
    },
    listReadyIssues: notImplemented("listReadyIssues"),
    getOpenPullRequestNumber: notImplemented("getOpenPullRequestNumber"),
    findOpenPullRequestNumber: notImplemented("findOpenPullRequestNumber"),
    createDraftPullRequest: notImplemented("createDraftPullRequest"),
    updateOpenDraftPullRequestCopy: notImplemented(
      "updateOpenDraftPullRequestCopy",
    ),
    countOpenNonDraftPullRequests: notImplemented(
      "countOpenNonDraftPullRequests",
    ),
    getPullRequestCheckStatus: notImplemented("getPullRequestCheckStatus"),
    getPrStatusCheckDiagnostics: notImplemented("getPrStatusCheckDiagnostics"),
    markPullRequestReadyForReview: notImplemented(
      "markPullRequestReadyForReview",
    ),
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
