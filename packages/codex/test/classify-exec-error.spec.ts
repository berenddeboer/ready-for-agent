import {
  CODEX_MODEL_AT_CAPACITY_MESSAGE,
  classifyCodexExecFailure,
} from "../src/lib/classify-exec-error.js"
import { describe, expect, it } from "bun:test"

const NOW = Date.parse("2026-10-19T04:00:00.000Z")

describe("classifyCodexExecFailure", () => {
  it("classifies the exact capacity message when the exec event has no structured code", () => {
    expect(
      classifyCodexExecFailure({
        error: { message: CODEX_MODEL_AT_CAPACITY_MESSAGE },
        now: NOW,
      }),
    ).toEqual({ classification: "retryable_provider_error" })
  })

  it("keeps the capacity classification when exec appends additional details", () => {
    expect(
      classifyCodexExecFailure({
        error: {
          message: `${CODEX_MODEL_AT_CAPACITY_MESSAGE} (cf-ray: abc)`,
        },
        now: NOW,
      }).classification,
    ).toBe("retryable_provider_error")
  })

  it("does not treat a nearby capacity sentence as the observed message", () => {
    expect(
      classifyCodexExecFailure({
        error: { message: "Selected model is at capacity." },
        now: NOW,
      }),
    ).toEqual({})
  })

  it("classifies a snake_case server_overloaded code on the exec error object", () => {
    expect(
      classifyCodexExecFailure({
        error: {
          message: CODEX_MODEL_AT_CAPACITY_MESSAGE,
          codex_error_info: "server_overloaded",
        },
        now: NOW,
      }),
    ).toEqual({
      classification: "retryable_provider_error",
      providerCode: "server_overloaded",
    })
  })

  it("classifies the camelCase app-server overload variant when the exec event includes it", () => {
    expect(
      classifyCodexExecFailure({
        error: {
          message: CODEX_MODEL_AT_CAPACITY_MESSAGE,
          codexErrorInfo: "serverOverloaded",
        },
        now: NOW,
      }),
    ).toEqual({
      classification: "retryable_provider_error",
      providerCode: "server_overloaded",
    })
  })

  it("keeps a machine-readable retry deadline for an explicit rate limit", () => {
    expect(
      classifyCodexExecFailure({
        error: {
          message: "rate limit exceeded",
          codex_error_info: "rate_limit_exceeded",
          retry_after: 30,
        },
        now: NOW,
      }),
    ).toEqual({
      classification: "retryable_provider_error",
      providerCode: "rate_limit_exceeded",
      retryAt: NOW + 30_000,
    })
  })

  it("classifies a 503 connection failure as a temporary server error", () => {
    expect(
      classifyCodexExecFailure({
        error: {
          message: "unexpected status 503",
          codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } },
        },
        now: NOW,
      }),
    ).toEqual({
      classification: "retryable_provider_error",
      providerCode: "http_connection_failed",
    })
  })

  it("classifies an internal server error code as retryable", () => {
    expect(
      classifyCodexExecFailure({
        error: {
          message: "We’re currently experiencing high demand.",
          codex_error_info: "internal_server_error",
        },
        now: NOW,
      }).classification,
    ).toBe("retryable_provider_error")
  })

  it("does not retry permanent billing exhaustion, even when the prose names a later time", () => {
    expect(
      classifyCodexExecFailure({
        error: {
          message:
            "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 5:56 PM.",
          codex_error_info: "usage_limit_exceeded",
          retry_after: 3600,
        },
        now: NOW,
      }),
    ).toEqual({ providerCode: "usage_limit_exceeded" })
  })

  it("classifies structured unauthorized and HTTP 401 as terminal auth, not retryable", () => {
    expect(
      classifyCodexExecFailure({
        error: {
          message: "refresh token failed",
          codex_error_info: "unauthorized",
        },
        now: NOW,
      }),
    ).toEqual({
      classification: "terminal_auth_error",
      providerCode: "unauthorized",
    })
    expect(
      classifyCodexExecFailure({
        error: {
          message:
            "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
          codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } },
        },
        now: NOW,
      }),
    ).toEqual({
      classification: "terminal_auth_error",
      providerCode: "http_connection_failed",
    })
  })

  it("does not retry an unavailable model, cancellation, or an unknown failure", () => {
    expect(
      classifyCodexExecFailure({
        error: {
          message:
            "The 'gpt-5.1-codex-mini' model is not supported when using Codex with a ChatGPT account.",
          codex_error_info: "other",
        },
        now: NOW,
      }),
    ).toEqual({ providerCode: "other" })
    expect(
      classifyCodexExecFailure({
        error: {
          message: "invalid model configuration",
          codex_error_info: "bad_request",
        },
        now: NOW,
      }),
    ).toEqual({ providerCode: "bad_request" })
    expect(
      classifyCodexExecFailure({
        error: { message: "interrupted (Ctrl-C)" },
        now: NOW,
      }),
    ).toEqual({})
    expect(
      classifyCodexExecFailure({
        error: { message: "boom" },
        now: NOW,
      }),
    ).toEqual({})
  })

  it("does not invent a retry deadline from usage-limit prose", () => {
    expect(
      classifyCodexExecFailure({
        error: {
          message:
            "You've hit your usage limit. Try again at Aug 8th, 2026 5:56 PM.",
        },
        now: NOW,
      }),
    ).toEqual({})
  })
})
