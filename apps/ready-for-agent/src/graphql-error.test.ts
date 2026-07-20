import {
  HARNESS_START_HINT,
  formatGraphqlRequestFailure,
  isGraphqlUnreachable,
} from "./graphql-error.ts"
import { describe, expect, test } from "bun:test"

describe("graphql unreachable detection", () => {
  test("detects Bun unable-to-connect failures", () => {
    const cause = new Error(
      "Unable to connect. Is the computer able to access the url?",
    )
    expect(isGraphqlUnreachable(cause)).toBe(true)
    expect(formatGraphqlRequestFailure(cause)).toContain(HARNESS_START_HINT)
  })

  test("detects ECONNREFUSED nested causes", () => {
    const cause = new Error("fetch failed", {
      cause: new Error("connect ECONNREFUSED 127.0.0.1:6056"),
    })
    expect(isGraphqlUnreachable(cause)).toBe(true)
    expect(formatGraphqlRequestFailure(cause)).toBe(
      `fetch failed\n\n${HARNESS_START_HINT}`,
    )
  })

  test("leaves application GraphQL errors unchanged", () => {
    const cause = new Error("Repository already registered")
    expect(isGraphqlUnreachable(cause)).toBe(false)
    expect(formatGraphqlRequestFailure(cause)).toBe(
      "Repository already registered",
    )
  })
})
