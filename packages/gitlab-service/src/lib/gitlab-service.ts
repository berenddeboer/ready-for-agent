import { Context, type Effect } from "effect"
import type {
  MergePullRequestOptions,
  MergePullRequestResult,
  PrStatusCheckDiagnostic,
  PrStatusCheckDiagnosticsOptions,
  PrStatusCheckDiagnosticsRequest,
  PullRequestCheckStatus,
  PullRequestLifecycleStatus,
} from "@ready-for-agent/github-service"
import type {
  GitLabProjectUnavailableError,
  GitLabRequestError,
} from "./errors.js"
import type { GitLabReadyLabeledIssue, GitLabRepository } from "./types.js"

export type GitLabServiceError =
  | GitLabProjectUnavailableError
  | GitLabRequestError

export interface GitLabServiceShape {
  /**
   * Verify Forge Host + Project Path against GitLab before persistence.
   * Returns the repository identity with the instance's canonical API/web host
   * (from project `web_url`) when it differs from the SSH/remote guess.
   */
  readonly verifyProject: (
    repository: GitLabRepository,
  ) => Effect.Effect<GitLabRepository, GitLabServiceError>
  /** Operator Forge User for the active ambient credential. */
  readonly getAuthenticatedUserLogin: (
    repository: GitLabRepository,
  ) => Effect.Effect<string, GitLabServiceError>
  /** Open Ready-labeled Issues mapped to the shared Forge issue domain. */
  readonly listReadyIssues: (
    repository: GitLabRepository,
  ) => Effect.Effect<readonly GitLabReadyLabeledIssue[], GitLabServiceError>
  /**
   * Whether credentials resolve for this Repository: a per-Repository vault
   * secret and/or ambient `GITLAB_TOKEN` / `glab` (layer-dependent).
   */
  readonly hasCredentials: (
    repository: GitLabRepository,
  ) => Effect.Effect<boolean, GitLabRequestError>
  /**
   * Whether ambient credentials resolve, ignoring Keymaxxer vault.
   * Callers that already paid for a vault metadata probe (miss or timeout)
   * use this so ambient-only Repositories are not blocked by a second vault RPC.
   * Ambient-only layers implement this the same as hasCredentials.
   */
  readonly hasAmbientCredentials: (
    repository: GitLabRepository,
  ) => Effect.Effect<boolean, GitLabRequestError>
  /**
   * Hard lookup of an open merge request for the exact source branch.
   * Fails when no open MR exists.
   */
  readonly getOpenPullRequestNumber: (
    repository: GitLabRepository,
    headRefName: string,
  ) => Effect.Effect<number, GitLabServiceError>
  /**
   * Soft lookup of an open merge request for the exact source branch.
   * Returns null when none exists (does not fail).
   */
  readonly findOpenPullRequestNumber: (
    repository: GitLabRepository,
    headRefName: string,
  ) => Effect.Effect<number | null, GitLabServiceError>
  /**
   * Create a draft merge request for head against the project default base
   * (or an explicit base). Returns the new MR iid. Does not push the head
   * branch; the caller must ensure the remote head exists.
   */
  readonly createDraftPullRequest: (
    repository: GitLabRepository,
    input: {
      readonly headRefName: string
      readonly title: string
      readonly body: string
      readonly baseRefName?: string
    },
  ) => Effect.Effect<number, GitLabServiceError>
  /**
   * When an open draft MR exists for the exact source branch, set its title
   * and description to the provided values. Non-draft open MRs are left
   * unchanged. Returns the open MR iid when one exists, otherwise null.
   */
  readonly updateOpenDraftPullRequestCopy: (
    repository: GitLabRepository,
    headRefName: string,
    input: {
      readonly title: string
      readonly body: string
    },
  ) => Effect.Effect<number | null, GitLabServiceError>
  /**
   * Count currently open, non-draft merge requests for the project.
   * Author, branch, labels, and Work Item ownership are ignored.
   */
  readonly countOpenNonDraftPullRequests: (
    repository: GitLabRepository,
  ) => Effect.Effect<number, GitLabServiceError>
  /**
   * Observe the open MR's head pipeline at job granularity as PR Status Checks.
   * Each job is one check; `allow_failure` failures and manual/canceled/skipped
   * jobs never contribute red/green terminals. GitLab never reports Expected.
   */
  readonly getPullRequestCheckStatus: (
    repository: GitLabRepository,
    headRefName: string,
  ) => Effect.Effect<PullRequestCheckStatus, GitLabServiceError>
  /**
   * Load harness diagnostics (job metadata + bounded pipeline-job trace) for
   * red PR Status Checks identified as `gitlab-job:<id>`.
   */
  readonly getPrStatusCheckDiagnostics: (
    repository: GitLabRepository,
    checks: readonly PrStatusCheckDiagnosticsRequest[],
    options?: PrStatusCheckDiagnosticsOptions,
  ) => Effect.Effect<readonly PrStatusCheckDiagnostic[], GitLabServiceError>
  /**
   * Clear the open MR's Draft flag (boolean + title prefix) so it is ready
   * for review. Idempotent when the MR is already non-draft.
   */
  readonly markPullRequestReadyForReview: (
    repository: GitLabRepository,
    headRefName: string,
  ) => Effect.Effect<void, GitLabServiceError>
  /**
   * Lifecycle state of the merge request on a source branch, or not found.
   * Used to detect harness or external merge/close outcomes on Refresh.
   */
  readonly getPullRequestLifecycleStatus: (
    repository: GitLabRepository,
    headRefName: string,
  ) => Effect.Effect<PullRequestLifecycleStatus, GitLabServiceError>
  /**
   * Merge the open MR on the exact source branch with the expected head SHA.
   * Project merge method settings govern squash vs merge commit (no harness
   * override). Already-merged is success; closed-unmerged and state races use
   * the shared MergePullRequestResult ladder (revalidation / needs_human).
   * Credential and transport failures remain GitLabServiceError.
   */
  readonly mergePullRequest: (
    repository: GitLabRepository,
    headRefName: string,
    options?: MergePullRequestOptions,
  ) => Effect.Effect<MergePullRequestResult, GitLabServiceError>
  /**
   * Ensure a No-Change Outcome summary is posted once (hidden Work Item marker)
   * and the Issue is closed. Idempotent across retries and already-closed Issues.
   */
  readonly ensureIssueCompletedWithSummary: (
    repository: GitLabRepository,
    issueNumber: number,
    workItemId: string,
    summaryMarkdown: string,
  ) => Effect.Effect<void, GitLabServiceError>
  /**
   * Close every open merge request whose source branch matches exactly.
   * Missing MRs are success (idempotent).
   */
  readonly closeOpenPullRequestsForBranch: (
    repository: GitLabRepository,
    headRefName: string,
  ) => Effect.Effect<void, GitLabServiceError>
  /**
   * Delete a remote branch by name. Missing branches are success (idempotent).
   */
  readonly deleteBranch: (
    repository: GitLabRepository,
    branchName: string,
  ) => Effect.Effect<void, GitLabServiceError>
}

export class GitLabService extends Context.Service<
  GitLabService,
  GitLabServiceShape
>()("@ready-for-agent/gitlab-service/GitLabService") {}
