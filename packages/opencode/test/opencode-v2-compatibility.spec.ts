import {
  OPENCODE_V2_AUTHENTICATION_DIAGNOSTIC,
  OPENCODE_V2_CLIENT_PACKAGE,
  OPENCODE_V2_MALFORMED_DIAGNOSTIC,
  OPENCODE_V2_REQUIRED_OPERATIONS,
  OPENCODE_V2_SERVICE_MISSING_DIAGNOSTIC,
  OPENCODE_V2_TRANSIENT_DIAGNOSTIC,
} from "../src/lib/opencode-v2-compatibility.js"
import { describe, expect, test } from "bun:test"

const USER_FACING_DIAGNOSTICS = [
  OPENCODE_V2_TRANSIENT_DIAGNOSTIC,
  OPENCODE_V2_SERVICE_MISSING_DIAGNOSTIC,
  OPENCODE_V2_AUTHENTICATION_DIAGNOSTIC,
  OPENCODE_V2_MALFORMED_DIAGNOSTIC,
] as const

describe("OpenCode V2 telemetry diagnostics", () => {
  test("documents the client operations the build-time contract checks", () => {
    expect(OPENCODE_V2_CLIENT_PACKAGE).toBe("@opencode/client")
    expect(OPENCODE_V2_REQUIRED_OPERATIONS).toEqual([
      "server.info",
      "session.get",
      "session.list",
      "session.message.list",
    ])
  })

  test("user-facing diagnostics do not reject a server version or mention a V1 fallback", () => {
    for (const diagnostic of USER_FACING_DIAGNOSTICS) {
      expect(diagnostic).not.toContain("not a supported V2 API")
      expect(diagnostic).not.toContain("V1 fallback")
    }
    expect(OPENCODE_V2_MALFORMED_DIAGNOSTIC).not.toContain("Retry in a moment")
    expect(OPENCODE_V2_AUTHENTICATION_DIAGNOSTIC).not.toContain(
      "Retry in a moment",
    )
  })
})
