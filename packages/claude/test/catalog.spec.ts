import { CLAUDE_STATIC_CATALOG, CLAUDE_THINKING_LEVELS } from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("CLAUDE_STATIC_CATALOG", () => {
  it("lists haiku, sonnet, opus, fable with official Thinking Levels only", () => {
    expect(CLAUDE_STATIC_CATALOG.map((model) => model.id)).toEqual([
      "haiku",
      "sonnet",
      "opus",
      "fable",
    ])

    for (const model of CLAUDE_STATIC_CATALOG) {
      expect(model.thinkingLevels).toEqual([...CLAUDE_THINKING_LEVELS])
      expect(model.thinkingLevels).not.toContain("ultracode")
    }

    // Excluded aliases / variants must not appear.
    const ids = CLAUDE_STATIC_CATALOG.map((model) => model.id)
    expect(ids).not.toContain("default")
    expect(ids).not.toContain("best")
    expect(ids).not.toContain("opusplan")
    expect(ids.some((id) => id.includes("[1m]"))).toBe(false)
  })
})
