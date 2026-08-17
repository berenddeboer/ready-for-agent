import { Effect, Layer } from "effect"
import {
  GitHubService,
  type GitHubServiceShape,
  type PullRequestLifecycleStatus,
} from "@ready-for-agent/github-service"

/**
 * Minimal GitHubService for Work Item Lifecycle unit tests.
 * Defaults PR lifecycle status to open so owned-PR + closed-Issue paths pause.
 */
export const stubGitHubServiceLayer = (
  overrides: Partial<GitHubServiceShape> = {},
): Layer.Layer<GitHubService> =>
  Layer.succeed(
    GitHubService,
    GitHubService.of({
      getAuthenticatedUserLogin: () => Effect.succeed("test-operator"),
      listReadyIssues: () => Effect.succeed([]),
      getOpenPullRequestNumber: () => Effect.succeed(1),
      findOpenPullRequestNumber: () => Effect.succeed(1),
      closeOpenPullRequestsAndDeleteBranch: () => Effect.void,
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
      observeAutomatedReviewEvidence: () =>
        Effect.succeed({
          _tag: "ambiguous" as const,
          reason: "Automated review evidence observation is not configured",
        }),
      getPullRequestLifecycleStatus: () =>
        Effect.succeed({ _tag: "open" } satisfies PullRequestLifecycleStatus),
      markPullRequestReadyForReview: () => Effect.void,
      mergePullRequest: () => Effect.succeed({ _tag: "merged" }),
      rerunWorkflowRun: () => Effect.void,
      uploadUserAttachment: () =>
        Effect.succeed(
          "https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000001",
        ),
      ensureIssueCompletedWithSummary: () => Effect.void,
      ...overrides,
    }),
  )
