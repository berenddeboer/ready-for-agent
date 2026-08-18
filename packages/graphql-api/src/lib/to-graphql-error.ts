import { GraphQLError } from "graphql"

type TaggedError = {
  readonly _tag: string
  readonly message?: string
  readonly field?: string
  readonly repositoryId?: string
  readonly workItemId?: string
  readonly stepRunId?: string
  readonly issueNumber?: number
  readonly state?: string
  readonly blockerCount?: number
  readonly reason?: string
  readonly operation?: string
  readonly forge?: string
  readonly forgeHost?: string
  readonly projectPath?: string
  readonly localPath?: string
  readonly path?: string
  readonly selectedBackendId?: string
  readonly activeBackendId?: string
  readonly unfinishedWorkItemCount?: number
  readonly scope?: string
  readonly retryAt?: number
  readonly sessionId?: string
  readonly used?: number
  readonly max?: number
}

const isTaggedError = (error: unknown): error is TaggedError =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  typeof (error as { _tag: unknown })._tag === "string"

const gql = (message: string, code: string, extensions?: object) =>
  new GraphQLError(message, {
    extensions: { code, ...extensions },
  })

/**
 * Map tagged domain failures (and GraphQLError) to GraphQL errors with
 * `extensions.code`. Dispatch is by `_tag` only — never `instanceof`.
 * Only tags resolvers can produce are listed; unknown tags fall back.
 */
export const toGraphQLError = (error: unknown): GraphQLError => {
  if (error instanceof GraphQLError) {
    return error
  }

  if (!isTaggedError(error)) {
    if (error instanceof Error) {
      return gql(error.message, "INTERNAL_SERVER_ERROR")
    }
    return gql("Unexpected error", "INTERNAL_SERVER_ERROR")
  }

  switch (error._tag) {
    case "IssueNotFoundError":
      return gql(
        `Issue #${error.issueNumber} was not found in repository ${error.repositoryId}`,
        "ISSUE_NOT_FOUND",
      )
    case "IssueNotOpenError":
      return gql(
        `Issue #${error.issueNumber} is ${error.state}, not OPEN`,
        "ISSUE_NOT_OPEN",
      )
    case "ParentIssueError":
      return gql(
        `Issue #${error.issueNumber} has child issues and must target a leaf Issue`,
        "ISSUE_IS_PARENT",
      )
    case "NotAParentIssueError":
      return gql(
        `Issue #${error.issueNumber} is not a Parent Issue`,
        "ISSUE_NOT_PARENT",
      )
    case "UnsupportedIssueHierarchyError":
      return gql(
        error.message ??
          `Issue #${error.issueNumber} is not a Supported Issue Hierarchy`,
        "UNSUPPORTED_ISSUE_HIERARCHY",
      )
    case "ImplementAllWithAutoMergeNotEligibleError":
      return gql(
        error.reason ??
          `Parent Issue #${error.issueNumber} is not eligible for Implement all with auto-merge`,
        "IMPLEMENT_ALL_WITH_AUTO_MERGE_NOT_ELIGIBLE",
      )
    case "IssueBlockedError":
      return gql(
        `Issue #${error.issueNumber} is blocked by ${error.blockerCount} issue(s)`,
        "ISSUE_BLOCKED",
      )
    case "IssueNotBlockedError":
      return gql(
        `Issue #${error.issueNumber} is not blocked and cannot be Queued; use Implement Now instead`,
        "ISSUE_NOT_BLOCKED",
      )
    case "UnfinishedWorkItemExistsError":
      return gql(
        `Issue #${error.issueNumber} already has an unfinished Work Item`,
        "UNFINISHED_WORK_ITEM_EXISTS",
        { workItemId: error.workItemId },
      )
    case "WorkItemWaitingForBlockersError":
      return gql(
        `Work Item ${error.workItemId} is Waiting for blockers and cannot ${
          error.operation ?? "be started"
        }`,
        "WORK_ITEM_WAITING_FOR_BLOCKERS",
        {
          workItemId: error.workItemId,
          operation: error.operation,
        },
      )
    case "BuildModelNotConfiguredError":
      return gql(
        error.message ?? "Build model not configured",
        "BUILD_MODEL_NOT_CONFIGURED",
      )
    case "InvalidExecutionProfileError":
      return gql(
        error.message ?? "Invalid Explicit Work Item Execution Profile",
        "INVALID_EXECUTION_PROFILE",
        { field: "field" in error ? error.field : undefined },
      )
    case "AgentBackendUnavailableError":
      return gql(
        error.message ?? "Agent Backend is unavailable",
        "AGENT_BACKEND_UNAVAILABLE",
        { reason: "reason" in error ? error.reason : error.message },
      )
    case "AgentBackendChangeBlockedError":
      return gql(
        error.message ??
          "Cannot change Agent Backend while Work Items are unfinished",
        "AGENT_BACKEND_CHANGE_BLOCKED",
        {
          unfinishedWorkItemCount:
            "unfinishedWorkItemCount" in error
              ? error.unfinishedWorkItemCount
              : undefined,
          scope: "scope" in error ? error.scope : undefined,
          repositoryId:
            "repositoryId" in error ? error.repositoryId : undefined,
        },
      )
    case "WorkItemLifecycleDatabaseError":
      return gql(
        error.message ?? "Work item lifecycle database error",
        "WORK_ITEM_LIFECYCLE_DATABASE_ERROR",
      )
    case "WorkItemNotFoundError":
      return gql(
        `Work Item not found: ${error.workItemId}`,
        "WORK_ITEM_NOT_FOUND",
      )
    case "SessionIdNotFoundError":
      return gql(
        `No Work Item owns Session ID: ${error.sessionId}`,
        "SESSION_NOT_FOUND",
        { sessionId: error.sessionId },
      )
    case "SessionIdAmbiguousError":
      return gql(
        `Multiple Work Items own Session ID: ${error.sessionId}`,
        "SESSION_AMBIGUOUS",
        { sessionId: error.sessionId },
      )
    case "WorkItemTerminalError":
      return gql(
        `Work Item ${error.workItemId} is already ${error.state}`,
        "WORK_ITEM_TERMINAL",
      )
    case "ActiveStepRunExistsError":
      return gql(
        `Work Item ${error.workItemId} already has an active Step Run`,
        "ACTIVE_STEP_RUN_EXISTS",
      )
    case "RetryNotEligibleError":
      return gql(
        `Work Item ${error.workItemId} cannot be retried: ${error.reason}`,
        "RETRY_NOT_ELIGIBLE",
      )
    case "InterruptNotEligibleError":
      return gql(
        `Work Item ${error.workItemId} cannot be interrupted: ${error.reason}`,
        "INTERRUPT_NOT_ELIGIBLE",
        {
          workItemId: error.workItemId,
          reason: error.reason,
        },
      )
    case "AutonomousRetryLimitReachedError":
      return gql(
        `Autonomous Retry Budget exhausted for Work Item ${error.workItemId}`,
        "LIMIT_REACHED",
        { used: error.used, max: error.max },
      )
    case "AutonomousRetryDeferredError":
      return gql(
        `Autonomous Retry deferred until ${
          typeof error.retryAt === "number"
            ? new Date(error.retryAt).toISOString()
            : "the provider retry time"
        }`,
        "DEFERRED",
        { retryAt: error.retryAt },
      )
    case "InvalidAutonomousRetryLimitError":
      return gql(
        error.message ?? "maxAutonomousRetries must be a non-negative integer",
        "INVALID_RETRY_SELECTOR",
      )
    case "InvalidRetrySelectorError":
      return gql(
        error.message ??
          "Exactly one of issueNumber, workItemId, or allRetryable=true is required",
        "INVALID_RETRY_SELECTOR",
        { reason: error.reason },
      )
    case "WorkItemNotInRepositoryError":
      return gql(
        `Work Item ${error.workItemId} does not belong to repository ${error.repositoryId}`,
        "WORK_ITEM_NOT_IN_REPOSITORY",
        {
          workItemId: error.workItemId,
          repositoryId: error.repositoryId,
        },
      )
    case "NoUnfinishedWorkItemError":
      return gql(
        `Issue #${error.issueNumber} has no unfinished Work Item in repository ${error.repositoryId}`,
        "NO_UNFINISHED_WORK_ITEM",
        {
          repositoryId: error.repositoryId,
          issueNumber: error.issueNumber,
        },
      )
    case "RepositoryCredentialError":
      return gql(
        error.message ?? "Repository credential error",
        "REPOSITORY_CREDENTIAL_ERROR",
      )
    case "GitLabProjectUnavailableError":
      return gql(
        `GitLab project ${error.projectPath} was not found on ${error.forgeHost}. Check the Forge Host and Project Path, then try again.`,
        "GITLAB_PROJECT_UNAVAILABLE",
        {
          forgeHost: error.forgeHost,
          projectPath: error.projectPath,
        },
      )
    case "GitLabRequestError":
      return gql(
        error.message ?? "GitLab request failed",
        "GITLAB_REQUEST_FAILED",
      )
    case "GitHubThrottledError": {
      const retryAt = error.retryAt
      const retryTime =
        typeof retryAt === "number" && Number.isFinite(retryAt)
          ? new Date(retryAt).toISOString()
          : "the GitHub reset time"
      return gql(
        `GitHub is throttling Harness requests until ${retryTime}`,
        "GITHUB_THROTTLED",
        { retryAt },
      )
    }
    case "RepositoryIdentityChangeBlockedError":
      return gql(
        error.message ??
          "Cannot change Repository Forge identity while Work Items exist",
        "REPOSITORY_IDENTITY_CHANGE_BLOCKED",
        { repositoryId: error.repositoryId },
      )
    case "KeymaxxerError":
      return gql(
        error.message ?? "Keymaxxer operation failed",
        "KEYMAXXER_ERROR",
      )
    case "RepositoryAlreadyExistsError":
      return gql(
        `Repository ${error.projectPath} already exists on ${error.forgeHost}`,
        "REPOSITORY_ALREADY_EXISTS",
      )
    case "InvalidConfigInputError":
      return gql(
        error.message ?? "Invalid config input",
        "INVALID_CONFIG_INPUT",
        {
          field: error.field,
        },
      )
    case "InvalidRepositorySettingsError":
      return gql(
        error.message ?? "Invalid repository settings",
        "INVALID_REPOSITORY_SETTINGS",
        { field: error.field },
      )
    case "LocalPathInUseError":
      return gql(
        `Local path already in use: ${error.localPath}`,
        "LOCAL_PATH_IN_USE",
      )
    case "InvalidRepositoryInputError":
      return gql(
        error.message ?? "Invalid repository input",
        "INVALID_REPOSITORY_INPUT",
        { field: error.field },
      )
    case "RepositoryNotFoundError":
      return gql(
        `Repository not found: ${error.repositoryId}`,
        "REPOSITORY_NOT_FOUND",
      )
    case "RepositoryHasRunningStepError":
      return gql(
        `Repository ${error.repositoryId} has a running Step Run and cannot be removed`,
        "REPOSITORY_HAS_RUNNING_STEP",
        {
          repositoryId: error.repositoryId,
          workItemId: error.workItemId,
          stepRunId: error.stepRunId,
        },
      )
    case "PathNotFound":
      return gql(
        error.message ?? `Path not found: ${error.path ?? ""}`,
        "PATH_NOT_FOUND",
        { path: error.path },
      )
    case "NotADirectory":
      return gql(
        error.message ?? `Not a directory: ${error.path ?? ""}`,
        "NOT_A_DIRECTORY",
        { path: error.path },
      )
    case "NotAGitRepository":
      return gql(
        error.message ?? `Not a git repository: ${error.path ?? ""}`,
        "NOT_A_GIT_REPOSITORY",
        { path: error.path },
      )
    case "NoForgeRemote":
      return gql(
        error.message ?? `No supported Forge remote found: ${error.path ?? ""}`,
        "NO_FORGE_REMOTE",
        { path: error.path },
      )
    case "DatabaseError":
      return gql(error.message ?? "Database error", "DATABASE_ERROR")
    case "EnqueueError":
      return gql(error.message ?? "Enqueue error", "ENQUEUE_ERROR")
    case "QueueReadError":
      return gql(error.message ?? "Queue read error", "QUEUE_READ_ERROR")
    case "ResetCleanupError":
      return gql(
        error.message ?? "Reset cleanup failed",
        "RESET_CLEANUP_FAILED",
      )
    case "AbandonCleanupError":
      return gql(
        error.message ?? "Abandon cleanup failed",
        "ABANDON_CLEANUP_FAILED",
      )
    default:
      if (typeof error.message === "string" && error.message.length > 0) {
        return gql(error.message, "INTERNAL_SERVER_ERROR")
      }
      return gql("Unexpected error", "INTERNAL_SERVER_ERROR")
  }
}
