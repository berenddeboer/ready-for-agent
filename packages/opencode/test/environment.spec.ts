import { makeOpencodeEnvironment } from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("makeOpencodeEnvironment", () => {
  it("forces remote Keymaxxer MCP with the capability URL", () => {
    expect(
      JSON.parse(
        makeOpencodeEnvironment({
          keymaxxerMcpUrl: "http://127.0.0.1:5032/cap/mcp",
          environment: {},
        }).OPENCODE_CONFIG_CONTENT,
      ),
    ).toEqual({
      mcp: {
        keymaxxer: {
          type: "remote",
          url: "http://127.0.0.1:5032/cap/mcp",
          enabled: true,
          oauth: false,
          timeout: 300_000,
        },
      },
    })
  })

  it("preserves existing configuration while overwriting keymaxxer", () => {
    const existingConfig = JSON.stringify({
      model: "anthropic/claude-sonnet-4-5",
      mcp: {
        filesystem: { enabled: true },
        keymaxxer: { enabled: true, timeout: 10_000, type: "local" },
      },
    })

    expect(
      JSON.parse(
        makeOpencodeEnvironment({
          keymaxxerMcpUrl: "http://127.0.0.1:5032/cap/mcp",
          environment: { OPENCODE_CONFIG_CONTENT: existingConfig },
        }).OPENCODE_CONFIG_CONTENT,
      ),
    ).toEqual({
      model: "anthropic/claude-sonnet-4-5",
      mcp: {
        filesystem: { enabled: true },
        keymaxxer: {
          type: "remote",
          url: "http://127.0.0.1:5032/cap/mcp",
          enabled: true,
          oauth: false,
          timeout: 300_000,
        },
      },
    })
  })

  it("strips GitHub token environment variables", () => {
    const env = makeOpencodeEnvironment({
      keymaxxerMcpUrl: "http://127.0.0.1:5032/cap/mcp",
      environment: {
        PATH: "/usr/bin",
        GH_TOKEN: "secret",
        GITHUB_TOKEN: "secret",
        GITHUB_TOKEN_ACME_WIDGETS: "secret",
        KEEP: "yes",
      },
    })
    expect(env.PATH).toBe("/usr/bin")
    expect(env.KEEP).toBe("yes")
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.GITHUB_TOKEN_ACME_WIDGETS).toBeUndefined()
  })

  it("fails closed when the capability URL is missing", () => {
    expect(() =>
      makeOpencodeEnvironment({ keymaxxerMcpUrl: "  ", environment: {} }),
    ).toThrow("keymaxxerMcpUrl is required")
  })
})
