import { AgentBackendExitError } from "../src/lib/errors.js"
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
})
