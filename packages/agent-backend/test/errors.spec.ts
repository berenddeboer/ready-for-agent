import { AgentBackendExitError } from "../src/lib/errors.js"
import { sanitizeAgentBackendStderrTail } from "../src/lib/sanitize-exit-message.js"
import { describe, expect, it } from "bun:test"

describe("AgentBackendExitError message", () => {
  it("accepts a human-readable reason", () => {
    const error = AgentBackendExitError.new({
      exitCode: 1,
      cwd: "/tmp",
      message: "Claude Code turn failed: permission denied",
    })
    expect(error.message).toBe("Claude Code turn failed: permission denied")
  })

  it("strips ANSI escapes and bounds length", () => {
    const esc = String.fromCharCode(0x1b)
    const longTail = "x".repeat(600)
    const error = AgentBackendExitError.new({
      exitCode: 1,
      cwd: "/tmp",
      message: `${esc}[31mboom happened${esc}[0m ${longTail}`,
    })
    expect(error.message.includes(`${esc}[`)).toBe(false)
    expect(error.message.startsWith("boom happened")).toBe(true)
    expect(error.message.length).toBeLessThanOrEqual(500)
  })

  it("redacts token-shaped secrets so they cannot reach the message", () => {
    const secret = "ghp_this_must_never_appear_in_exit_message"
    const error = AgentBackendExitError.new({
      exitCode: 1,
      cwd: "/tmp",
      message: `auth failed with ${secret}`,
    })
    expect(error.message).not.toContain(secret)
    expect(error.message).not.toMatch(/ghp_[A-Za-z0-9]+/)
    expect(error.message).toContain("[redacted]")
  })

  it("redacts AWS access keys so they cannot reach the message", () => {
    const secret = "AKIAIOSFODNN7EXAMPLE"
    const error = AgentBackendExitError.new({
      exitCode: 1,
      cwd: "/tmp",
      message: `ExpiredTokenException using ${secret}`,
    })
    expect(error.classification).toBe("terminal_auth_error")
    expect(error.message).not.toContain(secret)
    expect(error.message).toContain("[redacted]")
  })

  it("classifies expired AWS credentials as terminal_auth_error", () => {
    const error = AgentBackendExitError.new({
      exitCode: 1,
      cwd: "/tmp",
      message:
        "ExpiredTokenException: The security token included in the request is expired",
    })
    expect(error.classification).toBe("terminal_auth_error")
  })

  it("leaves an unrecognized failure unclassified", () => {
    const error = AgentBackendExitError.new({
      exitCode: 1,
      cwd: "/tmp",
      message: "npm install failed: EACCES",
    })
    expect(error.classification).toBeUndefined()
  })

  it("keeps an adapter-supplied classification", () => {
    const error = AgentBackendExitError.new({
      exitCode: 1,
      cwd: "/tmp",
      classification: "retryable_provider_error",
      message: "The security token included in the request is expired",
    })
    expect(error.classification).toBe("retryable_provider_error")
  })
})

describe("sanitizeAgentBackendStderrTail", () => {
  it("redacts a token that straddles the message-length cut", () => {
    const secret = "ghp_this_must_never_appear_in_exit_message"
    const text = `${"0".repeat(100)} ${secret} ${"1".repeat(470)}`
    const tail = sanitizeAgentBackendStderrTail(text)
    expect(tail).toBeDefined()
    expect(tail).toContain("[redacted]")
    expect(tail).not.toContain(secret)
    expect(tail).not.toMatch(/ghp_[A-Za-z0-9_]+/)
    expect(tail?.includes("this_must_never")).toBe(false)
    expect(tail?.length).toBeLessThanOrEqual(500)
  })
})
