import { Context, type Effect } from "effect"
import type {
  GitHubRepositoryUnavailableError,
  GitHubRequestError,
} from "./errors.js"
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

export interface GitHubServiceShape {
  readonly listReadyIssues: (
    repository: GitHubRepository,
  ) => Effect.Effect<
    readonly ReadyLabeledIssue[],
    GitHubRepositoryUnavailableError | GitHubRequestError
  >
  readonly getPullRequestCheckStatus: (
    repository: GitHubRepository,
    headRefName: string,
  ) => Effect.Effect<
    PullRequestCheckStatus,
    GitHubRepositoryUnavailableError | GitHubRequestError
  >
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
  ) => Effect.Effect<
    readonly PrStatusCheckDiagnostic[],
    GitHubRepositoryUnavailableError | GitHubRequestError
  >
  readonly getPullRequestLifecycleStatus: (
    repository: GitHubRepository,
    headRefName: string,
  ) => Effect.Effect<
    PullRequestLifecycleStatus,
    GitHubRepositoryUnavailableError | GitHubRequestError
  >
  readonly getOpenPullRequestNumber: (
    repository: GitHubRepository,
    headRefName: string,
  ) => Effect.Effect<
    number,
    GitHubRepositoryUnavailableError | GitHubRequestError
  >
  readonly markPullRequestReadyForReview: (
    repository: GitHubRepository,
    headRefName: string,
  ) => Effect.Effect<
    void,
    GitHubRepositoryUnavailableError | GitHubRequestError
  >
  readonly mergePullRequest: (
    repository: GitHubRepository,
    headRefName: string,
  ) => Effect.Effect<
    MergePullRequestResult,
    GitHubRepositoryUnavailableError | GitHubRequestError
  >
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
  ) => Effect.Effect<
    void,
    GitHubRepositoryUnavailableError | GitHubRequestError
  >
}

export class GitHubService extends Context.Service<
  GitHubService,
  GitHubServiceShape
>()("@ready-for-agent/github-service/GitHubService") {}
