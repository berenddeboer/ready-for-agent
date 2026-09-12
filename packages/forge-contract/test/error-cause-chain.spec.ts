import {
  buildReasonDetail,
  extractCauseChain,
  extractErrorCode,
  logErrorAnnotations,
  parseReasonDetail,
  serializeReasonDetail,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("error cause chain", () => {
  it("walks nested causes and surfaces the leaf code", () => {
    const leaf = Object.assign(
      new Error("self-signed certificate in certificate chain"),
      {
        code: "SELF_SIGNED_CERT_IN_CHAIN",
      },
    )
    const transport = new TypeError("fetch failed", { cause: leaf })
    const wrapped = {
      _tag: "GitHubRequestError",
      name: "GitHubRequestError",
      message: "Failed to list Ready-labeled Issues for acme/widgets",
      cause: transport,
      code: "SELF_SIGNED_CERT_IN_CHAIN",
    }

    expect(extractErrorCode(wrapped)).toBe("SELF_SIGNED_CERT_IN_CHAIN")
    expect(extractCauseChain(wrapped)).toEqual([
      {
        name: "GitHubRequestError",
        code: "SELF_SIGNED_CERT_IN_CHAIN",
        message: "Failed to list Ready-labeled Issues for acme/widgets",
      },
      {
        name: "TypeError",
        message: "fetch failed",
      },
      {
        name: "Error",
        code: "SELF_SIGNED_CERT_IN_CHAIN",
        message: "self-signed certificate in certificate chain",
      },
    ])

    const annotations = logErrorAnnotations(wrapped)
    expect(annotations.error).toBe(
      "Failed to list Ready-labeled Issues for acme/widgets",
    )
    expect(annotations.code).toBe("SELF_SIGNED_CERT_IN_CHAIN")
    expect(annotations.causeChain).toHaveLength(3)

    const detail = buildReasonDetail(wrapped)
    expect(detail).not.toBeNull()
    expect(detail?.code).toBe("SELF_SIGNED_CERT_IN_CHAIN")
    expect(JSON.parse(serializeReasonDetail(detail)!)).toEqual(detail)
  })

  it("returns an empty chain for uninformative values", () => {
    expect(extractCauseChain(null)).toEqual([])
    expect(extractCauseChain(undefined)).toEqual([])
    expect(extractErrorCode({})).toBeUndefined()
    expect(buildReasonDetail(null)).toBeNull()
  })

  it("persists a trustworthy provider retryAt on the Step Run reason", () => {
    const retryAt = "2026-08-15T13:00:00.000Z"
    const error = {
      _tag: "AgentBackendExitError",
      classification: "retryable_provider_error",
      retryAt: Date.parse(retryAt),
      message: "rate limited",
    }
    const detail = buildReasonDetail(error)
    expect(detail?.retryAt).toBe(retryAt)
    expect(parseReasonDetail(serializeReasonDetail(detail))).toEqual(detail)
  })

  it("maps Effect TimeoutError to code TIMEOUT", () => {
    const timeout = Object.assign(new Error(), {
      name: "TimeoutError",
      _tag: "TimeoutError",
    })
    expect(extractErrorCode(timeout)).toBe("TIMEOUT")
    expect(extractCauseChain(timeout)).toEqual([
      { name: "TimeoutError", code: "TIMEOUT" },
    ])
  })

  it("derives a cause-chain code from exitCode when code is absent", () => {
    const exitFailure = Object.assign(new Error("model overloaded"), {
      name: "AgentBackendExitError",
      _tag: "AgentBackendExitError",
      exitCode: 1,
    })
    expect(extractErrorCode(exitFailure)).toBe("1")
    expect(extractCauseChain(exitFailure)).toEqual([
      {
        name: "AgentBackendExitError",
        code: "1",
        message: "model overloaded",
      },
    ])
  })

  it("parses a persisted reason_detail blob into the typed cause chain", () => {
    const detail = {
      causeChain: [
        {
          name: "GitHubRequestError",
          code: "SELF_SIGNED_CERT_IN_CHAIN",
          message: "Failed to list Ready-labeled Issues for acme/widgets",
        },
        {
          name: "Error",
          code: "SELF_SIGNED_CERT_IN_CHAIN",
          message: "self-signed certificate in certificate chain",
        },
      ],
      code: "SELF_SIGNED_CERT_IN_CHAIN",
    }

    expect(parseReasonDetail(JSON.stringify(detail))).toEqual(detail)
  })

  it("returns null for missing, empty, or unparseable reason_detail", () => {
    expect(parseReasonDetail(null)).toBeNull()
    expect(parseReasonDetail(undefined)).toBeNull()
    expect(parseReasonDetail("")).toBeNull()
    expect(parseReasonDetail("   ")).toBeNull()
    expect(parseReasonDetail("not-json")).toBeNull()
    expect(parseReasonDetail("[]")).toBeNull()
    expect(parseReasonDetail(JSON.stringify({}))).toBeNull()
  })

  it("re-sanitizes stored link messages on parse", () => {
    const esc = String.fromCharCode(0x1b)
    const parsed = parseReasonDetail(
      JSON.stringify({
        causeChain: [
          {
            name: "Error",
            code: "ENOENT",
            message: `${esc}[31mENOENT: Executable not found in $PATH: "claude"${esc}[0m`,
          },
        ],
        code: "ENOENT",
      }),
    )

    expect(parsed).toEqual({
      causeChain: [
        {
          name: "Error",
          code: "ENOENT",
          message: 'ENOENT: Executable not found in $PATH: "claude"',
        },
      ],
      code: "ENOENT",
    })
  })
})
