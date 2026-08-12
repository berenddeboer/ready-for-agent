import { parseGrokModelsOutput } from "../src/index.js"
import { describe, expect, it } from "bun:test"

/** Grok CLI 1.0.3: default marked with `*`, other models listed with `-`. */
const GROK_CLI_1_0_3_MODELS_STDOUT = [
  "You are logged in with grok.com.",
  "",
  "Default model: grok-4.6",
  "",
  "Available models:",
  "  * grok-4.6 (default)",
  "  - grok-4.5",
].join("\n")

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

  it("includes dash-listed models from mixed-bullet grok models output", () => {
    const parsed = parseGrokModelsOutput(GROK_CLI_1_0_3_MODELS_STDOUT)
    expect(parsed.authenticated).toBe(true)
    expect(parsed.complete).toBe(true)
    expect(parsed.models.map((model) => model.id)).toEqual([
      "grok-4.6",
      "grok-4.5",
    ])
  })

  it("assigns grok-4.6 xhigh thinking levels and default levels to other models", () => {
    const parsed = parseGrokModelsOutput(
      `${GROK_CLI_1_0_3_MODELS_STDOUT}\n  - grok-future-model`,
    )
    expect(parsed.models).toEqual([
      {
        id: "grok-4.6",
        thinkingLevels: ["xhigh", "high", "medium", "low"],
      },
      {
        id: "grok-4.5",
        thinkingLevels: ["high", "medium", "low"],
      },
      {
        id: "grok-future-model",
        thinkingLevels: ["high", "medium", "low"],
      },
    ])
    expect(
      parsed.models.find((model) => model.id === "grok-4.5")?.thinkingLevels,
    ).not.toContain("xhigh")
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
