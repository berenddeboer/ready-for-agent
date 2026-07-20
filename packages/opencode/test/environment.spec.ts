import { Effect, Result } from "effect"
import { makeOpencodeEnvironment } from "../src/index.js"
import { OpencodeConfigError } from "../src/lib/errors.js"
import { describe, expect, it } from "bun:test"

const makeEnv = (options: Parameters<typeof makeOpencodeEnvironment>[0]) =>
  Effect.runSync(makeOpencodeEnvironment(options))

describe("makeOpencodeEnvironment", () => {
  it("forces remote Keymaxxer MCP with the capability URL", () => {
    expect(
      JSON.parse(
        makeEnv({
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
        makeEnv({
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
    const env = makeEnv({
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

  it("does not configure Keymaxxer when its capability URL is missing", () => {
    expect(
      JSON.parse(makeEnv({ environment: {} }).OPENCODE_CONFIG_CONTENT),
    ).toEqual({})
  })

  it("removes existing Keymaxxer configuration when disabled", () => {
    const existingConfig = JSON.stringify({
      model: "anthropic/claude-sonnet-4-5",
      mcp: {
        filesystem: { enabled: true },
        keymaxxer: { enabled: true, type: "local" },
      },
    })

    expect(
      JSON.parse(
        makeEnv({
          environment: { OPENCODE_CONFIG_CONTENT: existingConfig },
        }).OPENCODE_CONFIG_CONTENT,
      ),
    ).toEqual({
      model: "anthropic/claude-sonnet-4-5",
      mcp: { filesystem: { enabled: true } },
    })
  })

  it("fails with OpencodeConfigError for non-object OPENCODE_CONFIG_CONTENT", () => {
    const result = Effect.runSync(
      makeOpencodeEnvironment({
        environment: { OPENCODE_CONFIG_CONTENT: "[]" },
      }).pipe(Effect.result),
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(OpencodeConfigError)
      expect(result.failure.message).toBe(
        "OPENCODE_CONFIG_CONTENT must contain a JSON object",
      )
    }
  })

  it("fails with OpencodeConfigError for invalid JSON OPENCODE_CONFIG_CONTENT", () => {
    const result = Effect.runSync(
      makeOpencodeEnvironment({
        environment: { OPENCODE_CONFIG_CONTENT: "{" },
      }).pipe(Effect.result),
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(OpencodeConfigError)
    }
  })
})
