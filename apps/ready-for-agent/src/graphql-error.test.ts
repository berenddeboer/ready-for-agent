import { GenqlError } from "@ready-for-agent/graphql-client"
import {
  DEFAULT_HARNESS_BASE_URL,
  GRAPHQL_ERROR_CODE,
  GRAPHQL_URL_NOT_ENDPOINT_CODE,
  GraphqlUrlNotEndpointError,
  HARNESS_RESTART_UPGRADE_HINT,
  HARNESS_START_HINT,
  HARNESS_UNREACHABLE_CODE,
  HARNESS_VERSION_MISMATCH_CODE,
  describeGraphqlFailure,
  formatGraphqlRequestFailure,
  harnessBaseUrlFromGraphqlUrl,
  harnessNotRunningMessage,
  harnessVersionMismatchMessage,
  isGraphqlUnreachable,
} from "./graphql-error.ts"
import { describe, expect, test } from "bun:test"

describe("graphql unreachable detection", () => {
  test("detects Bun unable-to-connect failures without network wording", () => {
    const cause = new Error(
      "Unable to connect. Is the computer able to access the url?",
    )
    expect(isGraphqlUnreachable(cause)).toBe(true)
    const failure = describeGraphqlFailure(cause)
    expect(failure.code).toBe(HARNESS_UNREACHABLE_CODE)
    expect(failure.message).toBe(harnessNotRunningMessage())
    expect(failure.message).toContain(HARNESS_START_HINT)
    expect(failure.message).not.toContain("Unable to connect")
    expect(failure.message).not.toContain("access the url")
    expect(failure.message).toContain(DEFAULT_HARNESS_BASE_URL)
    // Start instruction appears once.
    expect(failure.message.split(HARNESS_START_HINT).length - 1).toBe(1)
  })

  test("detects ECONNREFUSED nested causes with configured GraphQL URL", () => {
    const cause = new Error("fetch failed", {
      cause: new Error("connect ECONNREFUSED 127.0.0.1:7000"),
    })
    expect(isGraphqlUnreachable(cause)).toBe(true)
    expect(
      describeGraphqlFailure(cause, {
        graphqlUrl: "http://127.0.0.1:7000/graphql",
      }),
    ).toEqual({
      code: HARNESS_UNREACHABLE_CODE,
      message: harnessNotRunningMessage("http://127.0.0.1:7000"),
    })
  })

  test("preserves GenqlError extensions.code for domain failures", () => {
    const cause = new GenqlError(
      [
        {
          message: "Repository owner/repo already exists on github.com",
          extensions: { code: "REPOSITORY_ALREADY_EXISTS" },
        },
      ],
      null,
    )
    expect(isGraphqlUnreachable(cause)).toBe(false)
    expect(describeGraphqlFailure(cause)).toEqual({
      code: "REPOSITORY_ALREADY_EXISTS",
      message: "Repository owner/repo already exists on github.com",
    })
  })

  test("falls back when GenqlError has no extensions.code", () => {
    const cause = new GenqlError([{ message: "something broke" }], null)
    expect(describeGraphqlFailure(cause)).toEqual({
      code: GRAPHQL_ERROR_CODE,
      message: "something broke",
    })
  })

  test("leaves plain application errors as GRAPHQL_ERROR", () => {
    const cause = new Error("Repository already registered")
    expect(isGraphqlUnreachable(cause)).toBe(false)
    expect(describeGraphqlFailure(cause)).toEqual({
      code: GRAPHQL_ERROR_CODE,
      message: "Repository already registered",
    })
    expect(formatGraphqlRequestFailure(cause)).toBe(
      "Repository already registered",
    )
  })

  test("maps HTML at the Harness origin to GRAPHQL_URL_NOT_ENDPOINT with /graphql hint", () => {
    const cause = new GraphqlUrlNotEndpointError("http://localhost:7000")
    expect(isGraphqlUnreachable(cause)).toBe(false)
    expect(describeGraphqlFailure(cause)).toEqual({
      code: GRAPHQL_URL_NOT_ENDPOINT_CODE,
      message:
        "http://localhost:7000 returned HTML (the Harness UI), not GraphQL. Set READY_FOR_AGENT_GRAPHQL_URL=http://localhost:7000/graphql",
    })
    expect(cause.message).not.toContain("/graphql/graphql")
  })

  test("maps HTML at a trailing-slash origin to GRAPHQL_URL_NOT_ENDPOINT without a double slash", () => {
    const cause = new GraphqlUrlNotEndpointError("http://localhost:7000/")
    expect(describeGraphqlFailure(cause)).toEqual({
      code: GRAPHQL_URL_NOT_ENDPOINT_CODE,
      message:
        "http://localhost:7000/ returned HTML (the Harness UI), not GraphQL. Set READY_FOR_AGENT_GRAPHQL_URL=http://localhost:7000/graphql",
    })
  })

  test("maps HTML at /graphql to GRAPHQL_URL_NOT_ENDPOINT without appending /graphql again", () => {
    const cause = new GraphqlUrlNotEndpointError(
      "http://localhost:7000/graphql/",
    )
    expect(describeGraphqlFailure(cause)).toEqual({
      code: GRAPHQL_URL_NOT_ENDPOINT_CODE,
      message:
        "http://localhost:7000/graphql/ returned HTML (the Harness UI), not GraphQL.",
    })
    expect(cause.message).not.toContain("Set READY_FOR_AGENT_GRAPHQL_URL")
    expect(cause.message).not.toContain("/graphql/graphql")
  })

  test("leaves a genuine JSON parse failure from a GraphQL endpoint as GRAPHQL_ERROR", () => {
    const cause = new Error("Failed to parse JSON")
    expect(describeGraphqlFailure(cause)).toEqual({
      code: GRAPHQL_ERROR_CODE,
      message: "Failed to parse JSON",
    })
  })

  test("harnessBaseUrlFromGraphqlUrl strips /graphql", () => {
    expect(harnessBaseUrlFromGraphqlUrl("http://127.0.0.1:6056/graphql")).toBe(
      "http://127.0.0.1:6056",
    )
    expect(harnessBaseUrlFromGraphqlUrl("http://127.0.0.1:7000/graphql/")).toBe(
      "http://127.0.0.1:7000",
    )
  })

  test("maps a missing intakeCandidates field to HARNESS_VERSION_MISMATCH", () => {
    const cause = new GenqlError(
      [
        {
          message: 'Cannot query field "intakeCandidates" on type "Query".',
          extensions: { code: "GRAPHQL_VALIDATION_FAILED" },
        },
      ],
      null,
    )
    expect(
      describeGraphqlFailure(cause, {
        graphqlUrl: "http://127.0.0.1:6056/graphql",
        cliVersion: "0.22.0",
        harnessVersion: "0.18.0",
      }),
    ).toEqual({
      code: HARNESS_VERSION_MISMATCH_CODE,
      message:
        "This CLI is v0.22.0 but the Harness on http://127.0.0.1:6056 is v0.18.0, which does not support `candidates`. Restart the Harness to upgrade: ready-for-agent start",
    })
  })

  test("maps a missing kanbanStatus field without a known Harness version", () => {
    const cause = new GenqlError(
      [
        {
          message: 'Cannot query field "kanbanStatus" on type "Query".',
          extensions: { code: "GRAPHQL_VALIDATION_FAILED" },
        },
      ],
      null,
    )
    expect(
      describeGraphqlFailure(cause, {
        graphqlUrl: "http://127.0.0.1:6056/graphql",
        cliVersion: "0.22.0",
      }),
    ).toEqual({
      code: HARNESS_VERSION_MISMATCH_CODE,
      message:
        "This CLI is v0.22.0 but the Harness on http://127.0.0.1:6056 does not support `status`. Restart the Harness to upgrade: ready-for-agent start",
    })
    expect(describeGraphqlFailure(cause).message).toContain(
      HARNESS_RESTART_UPGRADE_HINT,
    )
  })

  test("maps a missing retryWorkItems field to the retry command", () => {
    const cause = new GenqlError(
      [
        {
          message: 'Cannot query field "retryWorkItems" on type "Mutation".',
          extensions: { code: "GRAPHQL_VALIDATION_FAILED" },
        },
      ],
      null,
    )
    expect(
      describeGraphqlFailure(cause, {
        graphqlUrl: "http://127.0.0.1:7000/graphql",
        cliVersion: "0.22.0",
        harnessVersion: "0.18.0",
      }).message,
    ).toBe(
      "This CLI is v0.22.0 but the Harness on http://127.0.0.1:7000 is v0.18.0, which does not support `retry`. Restart the Harness to upgrade: ready-for-agent start",
    )
  })

  test("maps a missing startRepositoryIntake field to the intake command", () => {
    const cause = new GenqlError(
      [
        {
          message:
            'Cannot query field "startRepositoryIntake" on type "Mutation".',
          extensions: { code: "GRAPHQL_VALIDATION_FAILED" },
        },
      ],
      null,
    )
    expect(
      describeGraphqlFailure(cause, {
        graphqlUrl: "http://127.0.0.1:7000/graphql",
        cliVersion: "0.22.0",
        harnessVersion: "0.18.0",
      }).message,
    ).toBe(
      "This CLI is v0.22.0 but the Harness on http://127.0.0.1:7000 is v0.18.0, which does not support `intake`. Restart the Harness to upgrade: ready-for-agent start",
    )
  })

  test("leaves other GraphQL validation failures unchanged", () => {
    const cause = new GenqlError(
      [
        {
          message: 'Unknown argument "repository" on field "Query.health".',
          extensions: { code: "GRAPHQL_VALIDATION_FAILED" },
        },
      ],
      null,
    )
    expect(describeGraphqlFailure(cause)).toEqual({
      code: "GRAPHQL_VALIDATION_FAILED",
      message: 'Unknown argument "repository" on field "Query.health".',
    })
  })

  test("harnessVersionMismatchMessage uses the product v-prefix once", () => {
    expect(
      harnessVersionMismatchMessage({
        cliVersion: "v0.22.0",
        harnessVersion: "v0.18.0",
        harnessBaseUrl: "http://127.0.0.1:6056",
        command: "candidates",
      }),
    ).toBe(
      "This CLI is v0.22.0 but the Harness on http://127.0.0.1:6056 is v0.18.0, which does not support `candidates`. Restart the Harness to upgrade: ready-for-agent start",
    )
  })
})
