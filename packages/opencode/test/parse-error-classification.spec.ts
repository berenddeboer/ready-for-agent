import {
  parseErrorClassificationFromLine,
  parseProviderRetryAtFromLine,
} from "../src/lib/parse-error-classification.js"
import { describe, expect, it } from "bun:test"

const NOW = Date.parse("2026-08-15T12:00:00.000Z")

describe("parseErrorClassificationFromLine", () => {
  it("classifies a retryable APIError as retryable_provider_error", () => {
    const line = JSON.stringify({
      type: "error",
      sessionID: "ses_1",
      error: {
        name: "APIError",
        data: {
          message: "Overloaded",
          statusCode: 503,
          isRetryable: true,
        },
      },
    })
    expect(parseErrorClassificationFromLine(line)).toBe(
      "retryable_provider_error",
    )
  })

  it("classifies a 429 APIError as retryable even without isRetryable set", () => {
    const line = JSON.stringify({
      type: "error",
      error: {
        name: "APIError",
        data: {
          message: "Too Many Requests",
          statusCode: 429,
          isRetryable: false,
        },
      },
    })
    expect(parseErrorClassificationFromLine(line)).toBe(
      "retryable_provider_error",
    )
  })

  it("does not classify a non-retryable APIError", () => {
    const line = JSON.stringify({
      type: "error",
      error: {
        name: "APIError",
        data: {
          message: "Invalid request",
          statusCode: 400,
          isRetryable: false,
        },
      },
    })
    expect(parseErrorClassificationFromLine(line)).toBeUndefined()
  })

  it("classifies a MessageOutputLengthError as length_limit_truncation", () => {
    const line = JSON.stringify({
      type: "error",
      error: {
        name: "MessageOutputLengthError",
        data: {},
      },
    })
    expect(parseErrorClassificationFromLine(line)).toBe(
      "length_limit_truncation",
    )
  })

  it("classifies a ContextOverflowError as length_limit_truncation", () => {
    const line = JSON.stringify({
      type: "error",
      error: {
        name: "ContextOverflowError",
        data: { message: "Input exceeds context window of this model" },
      },
    })
    expect(parseErrorClassificationFromLine(line)).toBe(
      "length_limit_truncation",
    )
  })

  it("classifies a step_finish part with reason length as length_limit_truncation", () => {
    const line = JSON.stringify({
      type: "step_finish",
      sessionID: "ses_1",
      part: {
        type: "step-finish",
        reason: "length",
      },
    })
    expect(parseErrorClassificationFromLine(line)).toBe(
      "length_limit_truncation",
    )
  })

  it("does not classify a step_finish part with a natural stop reason", () => {
    const line = JSON.stringify({
      type: "step_finish",
      part: {
        type: "step-finish",
        reason: "stop",
      },
    })
    expect(parseErrorClassificationFromLine(line)).toBeUndefined()
  })

  it("falls back to undefined for an unrecognized error payload", () => {
    const line = JSON.stringify({
      type: "error",
      error: {
        name: "UnknownError",
        data: { message: "Unexpected server error." },
      },
    })
    expect(parseErrorClassificationFromLine(line)).toBeUndefined()
  })

  it("classifies a ProviderAuthError as terminal_auth_error", () => {
    const line = JSON.stringify({
      type: "error",
      error: {
        name: "ProviderAuthError",
        data: { providerID: "anthropic", message: "Not authenticated" },
      },
    })
    expect(parseErrorClassificationFromLine(line)).toBe("terminal_auth_error")
  })

  it("returns undefined for non-json lines", () => {
    expect(parseErrorClassificationFromLine("not json")).toBeUndefined()
  })

  it("returns undefined for unrelated event types", () => {
    expect(
      parseErrorClassificationFromLine(
        JSON.stringify({ type: "text", part: { type: "text", text: "hi" } }),
      ),
    ).toBeUndefined()
  })
})

describe("parseProviderRetryAtFromLine", () => {
  it("extracts retry-after seconds from a retryable APIError", () => {
    const line = JSON.stringify({
      type: "error",
      error: {
        name: "APIError",
        data: {
          message: "Too Many Requests",
          statusCode: 429,
          headers: { "retry-after": "60" },
        },
      },
    })
    expect(parseProviderRetryAtFromLine(line, NOW)).toBe(NOW + 60_000)
  })

  it("does not invent a wake time from prose or a non-retryable error", () => {
    expect(
      parseProviderRetryAtFromLine(
        JSON.stringify({
          type: "error",
          error: {
            name: "APIError",
            data: {
              message: "rate limited, retry in an hour",
              statusCode: 429,
            },
          },
        }),
        NOW,
      ),
    ).toBeUndefined()
    expect(
      parseProviderRetryAtFromLine(
        JSON.stringify({
          type: "error",
          error: {
            name: "APIError",
            data: {
              message: "Invalid request",
              statusCode: 400,
              retryAfter: 30,
            },
          },
        }),
        NOW,
      ),
    ).toBeUndefined()
  })
})
