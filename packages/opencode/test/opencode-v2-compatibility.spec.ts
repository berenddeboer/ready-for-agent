import {
  OPENCODE_V2_CLIENT_PACKAGE,
  OPENCODE_V2_REQUIRED_OPERATIONS,
  OPENCODE_V2_SUPPORTED_MAJOR,
  isSupportedOpenCodeServerVersion,
  openCodeV2IncompatibleDiagnostic,
} from "../src/lib/opencode-v2-compatibility.js"
import { describe, expect, test } from "bun:test"

describe("OpenCode V2 compatibility policy", () => {
  test("accepts only OpenCode 2.x and documents the experimental client", () => {
    expect(OPENCODE_V2_SUPPORTED_MAJOR).toBe(2)
    expect(OPENCODE_V2_CLIENT_PACKAGE).toBe("@opencode/client")
    expect(OPENCODE_V2_REQUIRED_OPERATIONS).toEqual([
      "server.info",
      "session.get",
      "session.list",
      "session.message.list",
    ])
    expect(isSupportedOpenCodeServerVersion("2.0.32")).toBe(true)
    expect(isSupportedOpenCodeServerVersion("v2.1.0")).toBe(true)
    expect(isSupportedOpenCodeServerVersion("1.9.9")).toBe(false)
    expect(isSupportedOpenCodeServerVersion("3.0.0")).toBe(false)
    expect(isSupportedOpenCodeServerVersion("not-a-version")).toBe(false)
  })

  test("incompatible diagnostic is not a transient retry and has no V1 fallback", () => {
    const diagnostic = openCodeV2IncompatibleDiagnostic("1.0.0")
    expect(diagnostic).toContain("compatibility failure")
    expect(diagnostic).toContain("no V1 fallback")
    expect(diagnostic).not.toContain("Retry in a moment")
    expect(diagnostic).not.toContain("opencode db path")
  })
})
