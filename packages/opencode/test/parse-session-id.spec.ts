import {
  parseSessionIdFromLine,
  parseSessionIdFromLines,
} from "../src/lib/parse-session-id.js"
import { describe, expect, it } from "bun:test"

describe("parseSessionIdFromLine", () => {
  it("extracts sessionID from a json event line", () => {
    const line = JSON.stringify({
      type: "text",
      timestamp: 1,
      sessionID: "ses_abc123",
    })
    expect(parseSessionIdFromLine(line)).toBe("ses_abc123")
  })

  it("returns undefined for non-json", () => {
    expect(parseSessionIdFromLine("not json")).toBeUndefined()
  })

  it("returns undefined when sessionID is missing", () => {
    expect(
      parseSessionIdFromLine(JSON.stringify({ type: "text" })),
    ).toBeUndefined()
  })
})

describe("parseSessionIdFromLines", () => {
  it("returns the last sessionID seen", () => {
    const lines = [
      JSON.stringify({ type: "step_start", sessionID: "ses_1" }),
      "noise",
      JSON.stringify({ type: "text", sessionID: "ses_2" }),
    ]
    expect(parseSessionIdFromLines(lines)).toBe("ses_2")
  })
})
