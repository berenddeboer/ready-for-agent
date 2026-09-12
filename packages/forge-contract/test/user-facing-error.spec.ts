import {
  extractHttpStatus,
  formatUserFacingError,
  isDeterministicForgeAuthFailure,
  isDeterministicForgeAuthHttpStatus,
  sanitizeUserFacingText,
  stripAnsi,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("user-facing error formatting", () => {
  const esc = String.fromCharCode(0x1b)
  const csiOpen = `${esc}[`

  it("strips ANSI CSI sequences from Effect-style dumps", () => {
    const colored = `{\n  ${esc}[0m_tag${esc}[2m:${esc}[0m ${esc}[32m"GitHubRequestError"${esc}[0m,\n  ${esc}[0mmessage${esc}[2m:${esc}[0m ${esc}[32m"boom happened"${esc}[0m,\n}`
    expect(stripAnsi(colored).includes(csiOpen)).toBe(false)
    expect(sanitizeUserFacingText(colored)).toBe("boom happened")
    expect(formatUserFacingError(colored, "fallback")).toBe("boom happened")
  })

  it("redacts token-shaped secrets from user-facing text", () => {
    const secret = "ghp_this_must_never_appear_in_user_facing_text"
    expect(sanitizeUserFacingText(`auth failed with ${secret}`)).not.toContain(
      secret,
    )
    expect(sanitizeUserFacingText(`auth failed with ${secret}`)).toContain(
      "[redacted]",
    )
  })

  it("lifts HTTP status out of postcondition diagnostics", () => {
    const flattened = formatUserFacingError({
      _tag: "CreatePrPostconditionError",
      message:
        "No open pull request found for acme/widgets:branch after native attempt and agent fallback",
      diagnostics:
        "createDraftPullRequest failed: Failed to create draft pull request for acme/widgets:branch: HTTP 401 Unauthorized",
    })
    expect(flattened).toContain("HTTP 401")
    expect(flattened).toContain("No open pull request found")
  })

  it("treats 401 and 403 as deterministic Forge auth failures, not 503", () => {
    expect(
      isDeterministicForgeAuthFailure({
        message: "Failed to merge pull request for acme/widgets:branch",
        statusCode: 401,
      }),
    ).toBe(true)
    expect(
      isDeterministicForgeAuthFailure({
        message: "Failed to merge pull request for acme/widgets:branch",
        statusCode: 403,
      }),
    ).toBe(true)
    expect(
      isDeterministicForgeAuthFailure({
        message: "Failed to merge pull request for acme/widgets:branch",
        statusCode: 503,
      }),
    ).toBe(false)
    expect(
      isDeterministicForgeAuthFailure({
        _tag: "CreatePrPostconditionError",
        message: "No open pull request found",
        diagnostics: "createDraftPullRequest failed: HTTP 401 Unauthorized",
      }),
    ).toBe(true)
    expect(isDeterministicForgeAuthHttpStatus(401)).toBe(true)
    expect(isDeterministicForgeAuthHttpStatus(403)).toBe(true)
    expect(isDeterministicForgeAuthHttpStatus(503)).toBe(false)
    expect(
      extractHttpStatus({
        message: "Failed to merge pull request for acme/widgets:branch",
        statusCode: 503,
      }),
    ).toBe(503)
  })
})
