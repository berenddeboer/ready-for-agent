import { toGraphQLError } from "../src/lib/to-graphql-error.js"
import { describe, expect, test } from "bun:test"

describe("toGraphQLError", () => {
  test("maps CiRepairNotAvailableError to CI_REPAIR_NOT_AVAILABLE", () => {
    const error = {
      _tag: "CiRepairNotAvailableError" as const,
      repositoryId: "repo-1",
      workItemId: "wi-1",
      message:
        "CI Repair is available only while a CI Failure Incident is active and Closed",
    }

    const gqlError = toGraphQLError(error)

    expect(gqlError.message).toContain("CI Failure Incident")
    expect(gqlError.extensions).toMatchObject({
      code: "CI_REPAIR_NOT_AVAILABLE",
      repositoryId: "repo-1",
      workItemId: "wi-1",
    })
  })

  test("maps IssueNotFoundError to ISSUE_NOT_FOUND with Forge #label", () => {
    const error = {
      _tag: "IssueNotFoundError" as const,
      repositoryId: "repo-1",
      issueNumber: 412,
      nativeId: "412",
    }

    const gqlError = toGraphQLError(error)

    expect(gqlError.message).toBe(
      "Issue #412 was not found in repository repo-1",
    )
    expect(gqlError.extensions).toMatchObject({
      code: "ISSUE_NOT_FOUND",
    })
  })

  test("maps IssueNotFoundError to ISSUE_NOT_FOUND with Linear native identity", () => {
    const error = {
      _tag: "IssueNotFoundError" as const,
      repositoryId: "repo-1",
      issueNumber: 0,
      nativeId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    }

    const gqlError = toGraphQLError(error)

    expect(gqlError.message).toBe(
      "Issue a1b2c3d4-e5f6-7890-abcd-ef1234567890 was not found in repository repo-1",
    )
    expect(gqlError.extensions).toMatchObject({
      code: "ISSUE_NOT_FOUND",
    })
  })

  test("maps IssueIdentityAmbiguousError to ISSUE_IDENTITY_AMBIGUOUS", () => {
    const error = {
      _tag: "IssueIdentityAmbiguousError" as const,
      repositoryId: "repo-1",
      issueNumber: 123,
      message: "Issue #123 matches 2 Issues on the current Issue Tracker.",
    }

    const gqlError = toGraphQLError(error)

    expect(gqlError.message).toContain("matches 2 Issues")
    expect(gqlError.extensions).toMatchObject({
      code: "ISSUE_IDENTITY_AMBIGUOUS",
      repositoryId: "repo-1",
      issueNumber: 123,
    })
  })

  test("maps LinearExecutionNotSupportedError to LINEAR_EXECUTION_NOT_SUPPORTED", () => {
    const error = {
      _tag: "LinearExecutionNotSupportedError" as const,
      repositoryId: "repo-1",
      message:
        "Linear Issue execution is not available yet. Discovery and settings work; implementation lands in a follow-up.",
    }

    const gqlError = toGraphQLError(error)

    expect(gqlError.message).toContain("not available yet")
    expect(gqlError.extensions).toMatchObject({
      code: "LINEAR_EXECUTION_NOT_SUPPORTED",
      repositoryId: "repo-1",
    })
  })

  test("maps InvalidExecutionProfileError to INVALID_EXECUTION_PROFILE", () => {
    const error = {
      _tag: "InvalidExecutionProfileError" as const,
      message: "Implement With requires a build Agent Model",
      field: "buildModel",
    }

    const gqlError = toGraphQLError(error)

    expect(gqlError.message).toBe("Implement With requires a build Agent Model")
    expect(gqlError.extensions).toMatchObject({
      code: "INVALID_EXECUTION_PROFILE",
      field: "buildModel",
    })
  })

  test("maps RepositoryHasRunningStepError to REPOSITORY_HAS_RUNNING_STEP", () => {
    const error = {
      _tag: "RepositoryHasRunningStepError" as const,
      repositoryId: "repo-1",
      workItemId: "wi-1",
      stepRunId: "sr-1",
    }

    const gqlError = toGraphQLError(error)

    expect(gqlError.message).toContain("running Step Run")
    expect(gqlError.message).toContain("repo-1")
    expect(gqlError.extensions).toMatchObject({
      code: "REPOSITORY_HAS_RUNNING_STEP",
      repositoryId: "repo-1",
      workItemId: "wi-1",
      stepRunId: "sr-1",
    })
  })

  test("maps SessionIdNotFoundError to SESSION_NOT_FOUND", () => {
    const error = {
      _tag: "SessionIdNotFoundError" as const,
      sessionId: "ses-missing",
    }

    const gqlError = toGraphQLError(error)

    expect(gqlError.message).toBe("No Work Item owns Session ID: ses-missing")
    expect(gqlError.extensions).toMatchObject({
      code: "SESSION_NOT_FOUND",
      sessionId: "ses-missing",
    })
  })

  test("maps InvalidRetrySelectorError to INVALID_RETRY_SELECTOR", () => {
    const error = {
      _tag: "InvalidRetrySelectorError" as const,
      reason: "exactly_one_selector",
      message:
        "Exactly one of issueNumber, workItemId, or allRetryable=true is required",
    }

    const gqlError = toGraphQLError(error)

    expect(gqlError.message).toContain("Exactly one")
    expect(gqlError.extensions).toMatchObject({
      code: "INVALID_RETRY_SELECTOR",
      reason: "exactly_one_selector",
    })
  })

  test("maps WorkItemNotInRepositoryError to WORK_ITEM_NOT_IN_REPOSITORY", () => {
    const error = {
      _tag: "WorkItemNotInRepositoryError" as const,
      workItemId: "wi-1",
      repositoryId: "repo-1",
    }

    const gqlError = toGraphQLError(error)

    expect(gqlError.message).toContain("wi-1")
    expect(gqlError.extensions).toMatchObject({
      code: "WORK_ITEM_NOT_IN_REPOSITORY",
      workItemId: "wi-1",
      repositoryId: "repo-1",
    })
  })

  test("maps NoUnfinishedWorkItemError to NO_UNFINISHED_WORK_ITEM", () => {
    const error = {
      _tag: "NoUnfinishedWorkItemError" as const,
      repositoryId: "repo-1",
      nativeId: "9",
    }

    const gqlError = toGraphQLError(error)

    expect(gqlError.message).toBe(
      "Issue #9 has no unfinished Work Item in repository repo-1",
    )
    expect(gqlError.extensions).toMatchObject({
      code: "NO_UNFINISHED_WORK_ITEM",
      nativeId: "9",
    })
  })

  test("maps SessionIdAmbiguousError to SESSION_AMBIGUOUS", () => {
    const error = {
      _tag: "SessionIdAmbiguousError" as const,
      sessionId: "ses-shared",
    }

    const gqlError = toGraphQLError(error)

    expect(gqlError.message).toBe(
      "Multiple Work Items own Session ID: ses-shared",
    )
    expect(gqlError.extensions).toMatchObject({
      code: "SESSION_AMBIGUOUS",
      sessionId: "ses-shared",
    })
  })

  test("maps InterruptNotEligibleError to INTERRUPT_NOT_ELIGIBLE", () => {
    const error = {
      _tag: "InterruptNotEligibleError" as const,
      workItemId: "wi-1",
      reason: "not_paused",
    }

    const gqlError = toGraphQLError(error)

    expect(gqlError.message).toContain("cannot be interrupted")
    expect(gqlError.extensions).toMatchObject({
      code: "INTERRUPT_NOT_ELIGIBLE",
      workItemId: "wi-1",
      reason: "not_paused",
    })
  })

  test("maps AzureDevOpsRequestError to AZURE_DEVOPS_REQUEST_FAILED", () => {
    const error = {
      _tag: "AzureDevOpsRequestError" as const,
      message:
        "Repository acme/widgets has no default branch; push an initial commit first",
    }

    const gqlError = toGraphQLError(error)

    expect(gqlError.message).toBe(
      "Repository acme/widgets has no default branch; push an initial commit first",
    )
    expect(gqlError.extensions).toMatchObject({
      code: "AZURE_DEVOPS_REQUEST_FAILED",
    })
  })

  test("maps AzureDevOpsProjectUnavailableError to AZURE_DEVOPS_PROJECT_UNAVAILABLE", () => {
    const error = {
      _tag: "AzureDevOpsProjectUnavailableError" as const,
      forge: "azure-devops",
      forgeHost: "dev.azure.com",
      projectPath: "acme/widgets",
    }

    const gqlError = toGraphQLError(error)

    expect(gqlError.message).toContain("acme/widgets")
    expect(gqlError.extensions).toMatchObject({
      code: "AZURE_DEVOPS_PROJECT_UNAVAILABLE",
      forgeHost: "dev.azure.com",
      projectPath: "acme/widgets",
    })
  })

  test("maps ParentImplementWithPauseNotAllowedError to PARENT_IMPLEMENT_WITH_PAUSE_NOT_ALLOWED", () => {
    const error = {
      _tag: "ParentImplementWithPauseNotAllowedError" as const,
      repositoryId: "repo-1",
      issueNumber: 10,
    }

    const gqlError = toGraphQLError(error)

    expect(gqlError.message).toBe(
      "Implement With cannot pause on Parent Issue #10",
    )
    expect(gqlError.extensions).toMatchObject({
      code: "PARENT_IMPLEMENT_WITH_PAUSE_NOT_ALLOWED",
    })
  })
})
