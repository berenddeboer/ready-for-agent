import {
  DEFAULT_HARNESS_BASE_URL,
  HARNESS_START_HINT,
  formatGraphqlRequestFailure,
  harnessBaseUrlFromGraphqlUrl,
  harnessNotRunningMessage,
  isGraphqlUnreachable,
} from "./graphql-error.ts"
import { describe, expect, test } from "bun:test"

describe("graphql unreachable detection", () => {
  test("detects Bun unable-to-connect failures without network wording", () => {
    const cause = new Error(
      "Unable to connect. Is the computer able to access the url?",
    )
    expect(isGraphqlUnreachable(cause)).toBe(true)
    const message = formatGraphqlRequestFailure(cause)
    expect(message).toBe(harnessNotRunningMessage())
    expect(message).toContain(HARNESS_START_HINT)
    expect(message).not.toContain("Unable to connect")
    expect(message).not.toContain("access the url")
    expect(message).toContain(DEFAULT_HARNESS_BASE_URL)
    // Start instruction appears once.
    expect(message.split(HARNESS_START_HINT).length - 1).toBe(1)
  })

  test("detects ECONNREFUSED nested causes with configured GraphQL URL", () => {
    const cause = new Error("fetch failed", {
      cause: new Error("connect ECONNREFUSED 127.0.0.1:7000"),
    })
    expect(isGraphqlUnreachable(cause)).toBe(true)
    expect(
      formatGraphqlRequestFailure(cause, {
        graphqlUrl: "http://127.0.0.1:7000/graphql",
      }),
    ).toBe(harnessNotRunningMessage("http://127.0.0.1:7000"))
  })

  test("leaves application GraphQL errors unchanged", () => {
    const cause = new Error("Repository already registered")
    expect(isGraphqlUnreachable(cause)).toBe(false)
    expect(formatGraphqlRequestFailure(cause)).toBe(
      "Repository already registered",
    )
  })

  test("harnessBaseUrlFromGraphqlUrl strips /graphql", () => {
    expect(harnessBaseUrlFromGraphqlUrl("http://127.0.0.1:6056/graphql")).toBe(
      "http://127.0.0.1:6056",
    )
    expect(harnessBaseUrlFromGraphqlUrl("http://127.0.0.1:7000/graphql/")).toBe(
      "http://127.0.0.1:7000",
    )
  })
})
