import { parseGrokModelsOutput } from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("parseGrokModelsOutput", () => {
  it("parses authenticated model catalog with default thinking levels", () => {
    const parsed = parseGrokModelsOutput(
      [
        "You are logged in with grok.com.",
        "",
        "Default model: grok-4.5",
        "",
        "Available models:",
        "  * grok-4.5 (default)",
        "  * grok-code-fast-1",
      ].join("\n"),
    )
    expect(parsed.authenticated).toBe(true)
    expect(parsed.complete).toBe(true)
    expect(parsed.models).toEqual([
      {
        id: "grok-4.5",
        thinkingLevels: ["high", "medium", "low"],
      },
      {
        id: "grok-code-fast-1",
        thinkingLevels: ["high", "medium", "low"],
      },
    ])
  })

  it("treats explicit unauthenticated output as inspection failure input", () => {
    const parsed = parseGrokModelsOutput(
      [
        "You are not authenticated.",
        "",
        "Default model: grok-4.5",
        "",
        "Available models:",
        "  * grok-4.5 (default)",
      ].join("\n"),
    )
    expect(parsed.authenticated).toBe(false)
    expect(parsed.models.map((model) => model.id)).toEqual(["grok-4.5"])
  })

  it("marks empty catalog incomplete", () => {
    const parsed = parseGrokModelsOutput("Available models:\n")
    expect(parsed.complete).toBe(false)
    expect(parsed.models).toEqual([])
  })
})
