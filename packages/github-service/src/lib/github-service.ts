import { Context, type Effect } from "effect"
import type {
  AutomatedReviewEvidenceCheck,
  AutomatedReviewEvidenceObservation,
} from "./automated-review-evidence.js"
import type { GitHubServiceError } from "./errors.js"
import type {
  GitHubRepository,
  MergePullRequestResult,
  PrStatusCheckDiagnostic,
  PrStatusCheckDiagnosticsOptions,
  PrStatusCheckDiagnosticsRequest,
  PullRequestCheckStatus,
  PullRequestLifecycleStatus,
  ReadyLabeledIssue,
} from "./types.js"

/**
 * Semantic source used by the harness to order GitHub API operations.
 *
 * This is deliberately a closed set: callers express why the operation is
 * happening, while the harness owns scheduling policy and numeric priorities.
 */
export type GitHubOperationOrigin =
  | "operator"
  | "lifecycle"
  | "polling"
  | "background"

export interface GitHubOperationOptions {
  readonly origin: GitHubOperationOrigin
}

export interface GitHubServiceShape {
  /**
   * Login of the authenticated principal for this Repository's credential
   * (Operator GitHub User). Same token path as other GitHub API calls.
   */
  readonly getAuthenticatedUserLogin: (
    repository: GitHubRepository,
    options?: GitHubOperationOptions,
  ) => Effect.Effect<string, GitHubServiceError>
  readonly listReadyIssues: (
    repository: GitHubRepository,
    options?: GitHubOperationOptions,
  ) => Effect.Effect<readonly ReadyLabeledIssue[], GitHubServiceError>
  readonly getPullRequestCheckStatus: (
    repository: GitHubRepository,
    headRefName: string,
  ) => Effect.Effect<PullRequestCheckStatus, GitHubServiceError>
  /**
   * Load harness diagnostics (job metadata + bounded log excerpt) for red
   * PR Status Checks. Prefer Actions job logs for `actions-job:<id>` ids;
   * Checks API 403 is expected for fine-grained PATs and is not treated as
   * a hard failure when an Actions identity is available.
   */
  readonly getPrStatusCheckDiagnostics: (
    repository: GitHubRepository,
    checks: readonly PrStatusCheckDiagnosticsRequest[],
    options?: PrStatusCheckDiagnosticsOptions,
  ) => Effect.Effect<readonly PrStatusCheckDiagnostic[], GitHubServiceError>
  /**
   * Observe whether a green-only Status Check Handoff has positive or
   * ambiguous automated-review evidence. Used by Investigate to skip an
   * Agent Turn when harness-owned GitHub data proves there is none.
   */
  readonly observeAutomatedReviewEvidence: (
    repository: GitHubRepository,
    headRefName: string,
    checks: readonly AutomatedReviewEvidenceCheck[],
  ) => Effect.Effect<AutomatedReviewEvidenceObservation, GitHubServiceError>
  readonly getPullRequestLifecycleStatus: (
    repository: GitHubRepository,
    headRefName: string,
  ) => Effect.Effect<PullRequestLifecycleStatus, GitHubServiceError>
  readonly getOpenPullRequestNumber: (
    repository: GitHubRepository,
    headRefName: string,
  ) => Effect.Effect<number, GitHubServiceError>
  /**
   * Soft lookup of an open pull request for the exact head branch.
   * Returns null when no open PR exists (does not fail).
   */
  readonly findOpenPullRequestNumber: (
    repository: GitHubRepository,
    headRefName: string,
  ) => Effect.Effect<number | null, GitHubServiceError>
  /**
   * Count currently open, non-draft pull requests for the Repository.
   * Author, branch, labels, and Work Item ownership are ignored. Merged,
   * closed-unmerged, and draft PRs are excluded.
   */
  readonly countOpenNonDraftPullRequests: (
    repository: GitHubRepository,
  ) => Effect.Effect<number, GitHubServiceError>
  /**
   * Create a draft pull request for head against the Repository default base
   * (or an explicit base). Returns the new PR number. Does not push the head
   * branch; the caller must ensure the remote head exists.
   */
  readonly createDraftPullRequest: (
    repository: GitHubRepository,
    input: {
      readonly headRefName: string
      readonly title: string
      readonly body: string
      readonly baseRefName?: string
    },
  ) => Effect.Effect<number, GitHubServiceError>
  /**
   * When an open draft PR exists for the exact head branch, set its title and
   * body to the provided values. Ready (non-draft) open PRs are left unchanged.
   * Returns the open PR number when one exists, otherwise null.
   */
  readonly updateOpenDraftPullRequestCopy: (
    repository: GitHubRepository,
    headRefName: string,
    input: {
      readonly title: string
      readonly body: string
    },
  ) => Effect.Effect<number | null, GitHubServiceError>
  readonly markPullRequestReadyForReview: (
    repository: GitHubRepository,
    headRefName: string,
  ) => Effect.Effect<void, GitHubServiceError>
  readonly mergePullRequest: (
    repository: GitHubRepository,
    headRefName: string,
  ) => Effect.Effect<MergePullRequestResult, GitHubServiceError>
  /**
   * Rerun an entire GitHub Actions workflow run (not failed-jobs-only).
   * Used by Investigate PR Status Checks for terminal incomplete automated
   * reviews after a durable rerun permit is reserved.
   */
  readonly rerunWorkflowRun: (
    repository: GitHubRepository,
    workflowRunId: number,
  ) => Effect.Effect<void, GitHubServiceError>
  /**
   * Ensure a No-Change Outcome summary is posted once (hidden Work Item marker)
   * and the Issue is closed with state reason COMPLETED. Idempotent across
   * retries and already-closed Issues.
   */
  readonly ensureIssueCompletedWithSummary: (
    repository: GitHubRepository,
    issueNumber: number,
    workItemId: string,
    summaryMarkdown: string,
  ) => Effect.Effect<void, GitHubServiceError>
}

export class GitHubService extends Context.Service<
  GitHubService,
  GitHubServiceShape
>()("@ready-for-agent/github-service/GitHubService") {}
