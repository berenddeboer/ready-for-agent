import { toGraphQLError } from "../src/lib/to-graphql-error.js"
import { describe, expect, test } from "bun:test"

describe("toGraphQLError", () => {
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
})
