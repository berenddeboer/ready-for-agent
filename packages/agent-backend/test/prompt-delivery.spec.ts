import { PROMPT_ARGV_BYTE_LIMIT, exceedsPromptArgvLimit } from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("exceedsPromptArgvLimit", () => {
  it("keeps prompts at or below the argv byte limit on argv", () => {
    expect(exceedsPromptArgvLimit("")).toBe(false)
    expect(exceedsPromptArgvLimit("fix the bug")).toBe(false)
    expect(exceedsPromptArgvLimit("x".repeat(PROMPT_ARGV_BYTE_LIMIT))).toBe(
      false,
    )
  })

  it("routes prompts above the argv byte limit out of band", () => {
    expect(exceedsPromptArgvLimit("x".repeat(PROMPT_ARGV_BYTE_LIMIT + 1))).toBe(
      true,
    )
  })

  it("measures utf-8 bytes rather than code units", () => {
    // Each emoji is 4 utf-8 bytes; 2 code units per emoji keeps `.length`
    // under the limit while the byte length exceeds it.
    const prompt = "😀".repeat(PROMPT_ARGV_BYTE_LIMIT / 4 + 1)
    expect(prompt.length).toBeLessThan(PROMPT_ARGV_BYTE_LIMIT)
    expect(exceedsPromptArgvLimit(prompt)).toBe(true)
  })

  it("stays under the Linux single-argument ceiling", () => {
    expect(PROMPT_ARGV_BYTE_LIMIT).toBeLessThan(128 * 1024)
  })
})
