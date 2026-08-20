import { Effect, Layer } from "effect"
import type {
  MergePullRequestResult,
  PullRequestCheckStatus,
  PullRequestLifecycleStatus,
} from "@ready-for-agent/github-service"
import { AzureDevOpsService } from "./azure-devops-service.js"
import {
  AzureDevOpsNotImplementedError,
  AzureDevOpsProjectUnavailableError,
  AzureDevOpsRequestError,
} from "./errors.js"
import type {
  AzureDevOpsReadyLabeledIssue,
  AzureDevOpsRepository,
} from "./types.js"

/**
 * Hand-written fake for the Azure DevOps service surface: the 15 REST-backed
 * methods plus the two local credential checks (`hasCredentials`/
 * `hasAmbientCredentials`). Mirrors
 * `gitlab-service-test.ts`'s in-memory `Map`-keyed `Layer.succeed` pattern:
 * no HTTP mocking library. Every other method (only
 * `countOpenNonDraftPullRequests` remains) fails with
 * `AzureDevOpsNotImplementedError`, matching the live layer, so callers
 * exercising unimplemented methods against this fake see the same error they
 * would see against `AzureDevOpsServiceLive`.
 */
export interface AzureDevOpsServiceTestFixture {
  readonly repository: AzureDevOpsRepository
  /**
   * `listReadyIssues` fixture. Populate `blockedBy` on individual issues to
   * exercise blocking-link behavior against the fake (the live layer's WIQL
   * + `System.LinkTypes.Dependency-Reverse` reads that produce this same
   * shape are covered separately, against a fake `fetch`, in
   * `test/azure-devops-service.spec.ts`).
   */
  readonly issues?: readonly AzureDevOpsReadyLabeledIssue[]
  readonly operatorLogin?: string
  readonly hasCredentials?: boolean
  /** Open pull request number keyed by exact source branch. */
  readonly openPullRequestByBranch?: Readonly<Record<string, number>>
  readonly pullRequestCheckStatus?: PullRequestCheckStatus
  readonly pullRequestLifecycleStatus?: PullRequestLifecycleStatus
  readonly mergePullRequestResult?: MergePullRequestResult
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
    listReadyIssues: (repository) =>
      failOr(repository, (state) =>
        Effect.succeed(
          [...(state.fixture.issues ?? [])].sort(
            (left, right) => left.number - right.number,
          ),
        ),
      ),
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
    getPullRequestCheckStatus: (repository) =>
      failOr(repository, (state) =>
        Effect.succeed(
          state.fixture.pullRequestCheckStatus ?? {
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
      failOr(repository, (state) =>
        Effect.succeed(
          state.fixture.pullRequestLifecycleStatus ??
            ({ _tag: "open" } satisfies PullRequestLifecycleStatus),
        ),
      ),
    mergePullRequest: (repository) =>
      failOr(repository, (state) =>
        Effect.succeed(
          state.fixture.mergePullRequestResult ??
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
