import { Effect, Layer } from "effect"
import {
  AzureDevOpsService,
  type AzureDevOpsServiceShape,
} from "@ready-for-agent/azure-devops-service"
import type { PullRequestLifecycleStatus } from "@ready-for-agent/github-service"

/**
 * Minimal AzureDevOpsService for Work Item Lifecycle unit tests.
 * Defaults PR lifecycle status to open so owned-PR + closed-Issue paths
 * pause, mirroring `gitlab-service-test.ts`'s stub.
 */
export const stubAzureDevOpsServiceLayer = (
  overrides: Partial<AzureDevOpsServiceShape> = {},
): Layer.Layer<AzureDevOpsService> =>
  Layer.succeed(
    AzureDevOpsService,
    AzureDevOpsService.of({
      verifyProject: (repository) => Effect.succeed(repository),
      getAuthenticatedUserLogin: () => Effect.succeed("test-operator"),
      listReadyIssues: () => Effect.succeed([]),
      hasCredentials: () => Effect.succeed(true),
      hasAmbientCredentials: () => Effect.succeed(true),
      getOpenPullRequestNumber: () => Effect.succeed(1),
      findOpenPullRequestNumber: () => Effect.succeed(1),
      createDraftPullRequest: () => Effect.succeed(1),
      updateOpenDraftPullRequestCopy: () => Effect.succeed(1),
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
        Effect.succeed({ _tag: "open" } satisfies PullRequestLifecycleStatus),
      mergePullRequest: () => Effect.succeed({ _tag: "merged" }),
      ensureIssueCompletedWithSummary: () => Effect.void,
      closeOpenPullRequestsForBranch: () => Effect.void,
      deleteBranch: () => Effect.void,
      ...overrides,
    }),
  )
