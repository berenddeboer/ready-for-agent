import { makeOpencodeEnvironment } from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("makeOpencodeEnvironment", () => {
  it("disables OpenCode's Keymaxxer MCP", () => {
    expect(
      JSON.parse(makeOpencodeEnvironment({}).OPENCODE_CONFIG_CONTENT),
    ).toEqual({ mcp: { keymaxxer: { enabled: false } } })
  })

  it("preserves existing configuration while disabling Keymaxxer", () => {
    const existingConfig = JSON.stringify({
      model: "anthropic/claude-sonnet-4-5",
      mcp: {
        filesystem: { enabled: true },
        keymaxxer: { enabled: true, timeout: 10_000 },
      },
    })

    expect(
      JSON.parse(
        makeOpencodeEnvironment({
          OPENCODE_CONFIG_CONTENT: existingConfig,
        }).OPENCODE_CONFIG_CONTENT,
      ),
    ).toEqual({
      model: "anthropic/claude-sonnet-4-5",
      mcp: {
        filesystem: { enabled: true },
        keymaxxer: { enabled: false, timeout: 10_000 },
      },
    })
  })
})
