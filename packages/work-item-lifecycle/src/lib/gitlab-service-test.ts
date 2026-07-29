import { Effect, Layer } from "effect"
import type {
  MergePullRequestResult,
  PullRequestLifecycleStatus,
} from "@ready-for-agent/github-service"
import {
  GitLabService,
  type GitLabServiceShape,
} from "@ready-for-agent/gitlab-service"

/**
 * Minimal GitLabService for Work Item Lifecycle unit tests.
 * Defaults PR lifecycle status to open so owned-PR + closed-Issue paths pause.
 */
export const stubGitLabServiceLayer = (
  overrides: Partial<GitLabServiceShape> = {},
): Layer.Layer<GitLabService> =>
  Layer.succeed(
    GitLabService,
    GitLabService.of({
      verifyProject: () => Effect.void,
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
      mergePullRequest: () =>
        Effect.succeed({ _tag: "merged" } satisfies MergePullRequestResult),
      ensureIssueCompletedWithSummary: () => Effect.void,
      closeOpenPullRequestsForBranch: () => Effect.void,
      deleteBranch: () => Effect.void,
      ...overrides,
    }),
  )
