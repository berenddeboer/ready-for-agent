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
  AzureDevOpsNotImplementedError,
  AzureDevOpsProjectUnavailableError,
  AzureDevOpsRequestError,
} from "./errors.js"
import type {
  AzureDevOpsReadyLabeledIssue,
  AzureDevOpsRepository,
} from "./types.js"

export type AzureDevOpsServiceError =
  | AzureDevOpsProjectUnavailableError
  | AzureDevOpsRequestError
  | AzureDevOpsNotImplementedError

/**
 * Same 18-method surface as {@link @ready-for-agent/gitlab-service#GitLabServiceShape}.
 * Only `countOpenNonDraftPullRequests` still fails with
 * `AzureDevOpsNotImplementedError`; every other method is implemented
 * against the real Azure DevOps REST API (see method-level docs).
 */
export interface AzureDevOpsServiceShape {
  /**
   * Verify Organization + Project against Azure DevOps before persistence
   * (`GET _apis/projects/{project}`). Implemented.
   */
  readonly verifyProject: (
    repository: AzureDevOpsRepository,
  ) => Effect.Effect<AzureDevOpsRepository, AzureDevOpsServiceError>
  /**
   * Operator Forge User for the active PAT (`GET _apis/connectionData`).
   * Implemented.
   */
  readonly getAuthenticatedUserLogin: (
    repository: AzureDevOpsRepository,
  ) => Effect.Effect<string, AzureDevOpsServiceError>
  /**
   * Open work items tagged `ready-for-agent` via a WIQL
   * `[System.Tags] CONTAINS 'ready-for-agent'` query, followed by a batch
   * fetch (`$expand=all`) for fields and relations. `blockedBy` is populated
   * from native `System.LinkTypes.Dependency-Reverse` (Predecessor) links,
   * filtered to currently-open blockers — the same posture as GitHub's
   * `blockedBy`, not a task-list/tag convention. Implemented.
   */
  readonly listReadyIssues: (
    repository: AzureDevOpsRepository,
  ) => Effect.Effect<
    readonly AzureDevOpsReadyLabeledIssue[],
    AzureDevOpsServiceError
  >
  /**
   * Whether credentials resolve for this Repository: a per-Repository vault
   * secret and/or the ambient `AZURE_DEVOPS_EXT_PAT` (layer-dependent).
   * Implemented.
   */
  readonly hasCredentials: (
    repository: AzureDevOpsRepository,
  ) => Effect.Effect<boolean, AzureDevOpsRequestError>
  /**
   * Whether ambient credentials resolve, ignoring Keymaxxer vault.
   * Ambient-only layers implement this the same as hasCredentials.
   * Implemented.
   */
  readonly hasAmbientCredentials: (
    repository: AzureDevOpsRepository,
  ) => Effect.Effect<boolean, AzureDevOpsRequestError>
  /** Hard lookup of an open pull request for the exact source branch. Not yet implemented. */
  readonly getOpenPullRequestNumber: (
    repository: AzureDevOpsRepository,
    headRefName: string,
  ) => Effect.Effect<number, AzureDevOpsServiceError>
  /** Soft lookup of an open pull request for the exact source branch. Not yet implemented. */
  readonly findOpenPullRequestNumber: (
    repository: AzureDevOpsRepository,
    headRefName: string,
  ) => Effect.Effect<number | null, AzureDevOpsServiceError>
  /** Create a draft pull request for head against the project default base. Not yet implemented. */
  readonly createDraftPullRequest: (
    repository: AzureDevOpsRepository,
    input: {
      readonly headRefName: string
      readonly title: string
      readonly body: string
      readonly baseRefName?: string
    },
  ) => Effect.Effect<number, AzureDevOpsServiceError>
  /** Set an open draft pull request's title/description. Not yet implemented. */
  readonly updateOpenDraftPullRequestCopy: (
    repository: AzureDevOpsRepository,
    headRefName: string,
    input: {
      readonly title: string
      readonly body: string
    },
  ) => Effect.Effect<number | null, AzureDevOpsServiceError>
  /** Count currently open, non-draft pull requests for the project. Not yet implemented. */
  readonly countOpenNonDraftPullRequests: (
    repository: AzureDevOpsRepository,
  ) => Effect.Effect<number, AzureDevOpsServiceError>
  /**
   * Observe build validation / branch policy checks as PR Status Checks
   * (`GET .../pullrequests/{id}/statuses` + the policy evaluations API).
   * Implemented.
   */
  readonly getPullRequestCheckStatus: (
    repository: AzureDevOpsRepository,
    headRefName: string,
  ) => Effect.Effect<PullRequestCheckStatus, AzureDevOpsServiceError>
  /**
   * Load harness diagnostics for red PR Status Checks: build logs for policy
   * evaluations backed by a build; unavailable for plain PR statuses (Azure
   * DevOps exposes no log content for those). Implemented.
   */
  readonly getPrStatusCheckDiagnostics: (
    repository: AzureDevOpsRepository,
    checks: readonly PrStatusCheckDiagnosticsRequest[],
    options?: PrStatusCheckDiagnosticsOptions,
  ) => Effect.Effect<
    readonly PrStatusCheckDiagnostic[],
    AzureDevOpsServiceError
  >
  /** Clear the open pull request's Draft flag. Implemented. */
  readonly markPullRequestReadyForReview: (
    repository: AzureDevOpsRepository,
    headRefName: string,
  ) => Effect.Effect<void, AzureDevOpsServiceError>
  /** Lifecycle state of the pull request on a source branch, or not found. Implemented. */
  readonly getPullRequestLifecycleStatus: (
    repository: AzureDevOpsRepository,
    headRefName: string,
  ) => Effect.Effect<PullRequestLifecycleStatus, AzureDevOpsServiceError>
  /**
   * Merge the open pull request on the exact source branch
   * (`PATCH .../pullrequests/{id}` with `status: "completed"`). Implemented.
   */
  readonly mergePullRequest: (
    repository: AzureDevOpsRepository,
    headRefName: string,
    options?: MergePullRequestOptions,
  ) => Effect.Effect<MergePullRequestResult, AzureDevOpsServiceError>
  /**
   * Post a completion summary comment and transition the work item to its
   * type's Completed-category state (falling back to `Closed`). Implemented.
   */
  readonly ensureIssueCompletedWithSummary: (
    repository: AzureDevOpsRepository,
    issueNumber: number,
    workItemId: string,
    summaryMarkdown: string,
  ) => Effect.Effect<void, AzureDevOpsServiceError>
  /**
   * Abandon every active pull request whose source branch matches exactly
   * (`PATCH .../pullrequests/{id}` with `status: "abandoned"`). Implemented.
   */
  readonly closeOpenPullRequestsForBranch: (
    repository: AzureDevOpsRepository,
    headRefName: string,
  ) => Effect.Effect<void, AzureDevOpsServiceError>
  /**
   * Delete a remote branch by name
   * (`POST .../refs` with `newObjectId: "0000...0000"`). Implemented.
   */
  readonly deleteBranch: (
    repository: AzureDevOpsRepository,
    branchName: string,
  ) => Effect.Effect<void, AzureDevOpsServiceError>
}

export class AzureDevOpsService extends Context.Service<
  AzureDevOpsService,
  AzureDevOpsServiceShape
>()("@ready-for-agent/azure-devops-service/AzureDevOpsService") {}
