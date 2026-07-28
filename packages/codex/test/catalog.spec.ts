import { CODEX_STATIC_CATALOG } from "../src/index.js"
import { describe, expect, it } from "bun:test"

/** gpt-5.5 and later: minor version after `gpt-5.` is >= 5. */
const isGpt55OrLater = (id: string): boolean => {
  const match = /^gpt-5\.(\d+)/.exec(id)
  if (match === null) {
    return false
  }
  return Number(match[1]) >= 5
}

describe("CODEX_STATIC_CATALOG", () => {
  it("lists only gpt-5.5-and-up models with non-empty Thinking Levels", () => {
    expect(CODEX_STATIC_CATALOG.length).toBeGreaterThan(0)

    for (const model of CODEX_STATIC_CATALOG) {
      expect(model.id.length).toBeGreaterThan(0)
      expect(isGpt55OrLater(model.id)).toBe(true)
      expect(model.thinkingLevels.length).toBeGreaterThan(0)
      for (const level of model.thinkingLevels) {
        expect(level.length).toBeGreaterThan(0)
      }
    }

    const ids = CODEX_STATIC_CATALOG.map((model) => model.id)
    expect(ids).toContain("gpt-5.5")
    expect(ids.some((id) => id.startsWith("gpt-5.6"))).toBe(true)
    // Legacy generation must not appear.
    expect(ids.some((id) => id.startsWith("gpt-5.4"))).toBe(false)
    expect(ids.some((id) => id.startsWith("gpt-5.3"))).toBe(false)
  })
})
