import { GraphQLError } from "graphql"

type TaggedError = {
  readonly _tag: string
  readonly message?: string
  readonly field?: string
  readonly repositoryId?: string
  readonly workItemId?: string
  readonly githubIssueNumber?: number
  readonly state?: string
  readonly blockerCount?: number
  readonly reason?: string
  readonly githubOwner?: string
  readonly githubRepo?: string
  readonly localPath?: string
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
        `Issue #${error.githubIssueNumber} was not found in repository ${error.repositoryId}`,
        "ISSUE_NOT_FOUND",
      )
    case "IssueNotOpenError":
      return gql(
        `Issue #${error.githubIssueNumber} is ${error.state}, not OPEN`,
        "ISSUE_NOT_OPEN",
      )
    case "ParentIssueError":
      return gql(
        `Issue #${error.githubIssueNumber} has child issues and cannot be implemented directly`,
        "ISSUE_IS_PARENT",
      )
    case "IssueBlockedError":
      return gql(
        `Issue #${error.githubIssueNumber} is blocked by ${error.blockerCount} issue(s)`,
        "ISSUE_BLOCKED",
      )
    case "UnfinishedWorkItemExistsError":
      return gql(
        `Issue #${error.githubIssueNumber} already has an unfinished Work Item`,
        "UNFINISHED_WORK_ITEM_EXISTS",
        { workItemId: error.workItemId },
      )
    case "BuildModelNotConfiguredError":
      return gql(
        error.message ?? "Build model not configured",
        "BUILD_MODEL_NOT_CONFIGURED",
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
    case "RepositoryCredentialError":
      return gql(
        error.message ?? "Repository credential error",
        "REPOSITORY_CREDENTIAL_ERROR",
      )
    case "RepositoryAlreadyExistsError":
      return gql(
        `Repository ${error.githubOwner}/${error.githubRepo} already exists`,
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
    case "DatabaseError":
      return gql(error.message ?? "Database error", "DATABASE_ERROR")
    case "EnqueueError":
      return gql(error.message ?? "Enqueue error", "ENQUEUE_ERROR")
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
