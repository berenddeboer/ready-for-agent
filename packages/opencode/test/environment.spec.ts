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
          keymaxxerMcpUrl: "http://127.0.0.1:6057/cap/mcp",
          environment: {},
        }).OPENCODE_CONFIG_CONTENT,
      ),
    ).toEqual({
      mcp: {
        keymaxxer: {
          type: "remote",
          url: "http://127.0.0.1:6057/cap/mcp",
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
          keymaxxerMcpUrl: "http://127.0.0.1:6057/cap/mcp",
          environment: { OPENCODE_CONFIG_CONTENT: existingConfig },
        }).OPENCODE_CONFIG_CONTENT,
      ),
    ).toEqual({
      model: "anthropic/claude-sonnet-4-5",
      mcp: {
        filesystem: { enabled: true },
        keymaxxer: {
          type: "remote",
          url: "http://127.0.0.1:6057/cap/mcp",
          enabled: true,
          oauth: false,
          timeout: 300_000,
        },
      },
    })
  })

  it("strips Forge token environment variables when vault MCP is configured", () => {
    const env = makeEnv({
      keymaxxerMcpUrl: "http://127.0.0.1:6057/cap/mcp",
      environment: {
        PATH: "/usr/bin",
        GH_TOKEN: "secret",
        GITHUB_TOKEN: "secret",
        GITHUB_TOKEN_ACME_WIDGETS: "secret",
        GITLAB_TOKEN: "secret",
        GITLAB_TOKEN_ACME_WIDGETS: "secret",
        SQLITE_DATABASE_PATH: "/tmp/ready-for-agent.db",
        KEYMAXXER_SIDECAR_URL: "http://127.0.0.1:6057/cap/mcp",
        KEEP: "yes",
      },
    })
    expect(env.PATH).toBe("/usr/bin")
    expect(env.KEEP).toBe("yes")
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.GITHUB_TOKEN_ACME_WIDGETS).toBeUndefined()
    expect(env.GITLAB_TOKEN).toBeUndefined()
    expect(env.GITLAB_TOKEN_ACME_WIDGETS).toBeUndefined()
    expect(env.SQLITE_DATABASE_PATH).toBeUndefined()
    expect(env.KEYMAXXER_SIDECAR_URL).toBeUndefined()
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT).mcp.keymaxxer.url).toBe(
      "http://127.0.0.1:6057/cap/mcp",
    )
  })

  it("preserves ambient Forge tokens when vault MCP is not configured", () => {
    const env = makeEnv({
      environment: {
        PATH: "/usr/bin",
        GH_TOKEN: "secret",
        GITHUB_TOKEN: "secret",
        GITHUB_TOKEN_ACME_WIDGETS: "secret",
        GITLAB_TOKEN: "secret",
        GITLAB_TOKEN_ACME_WIDGETS: "secret",
        SQLITE_DATABASE_PATH: "/tmp/ready-for-agent.db",
        KEYMAXXER_SIDECAR_URL: "http://127.0.0.1:6057/cap/mcp",
        KEEP: "yes",
      },
    })
    expect(env.PATH).toBe("/usr/bin")
    expect(env.KEEP).toBe("yes")
    expect(env.GH_TOKEN).toBe("secret")
    expect(env.GITHUB_TOKEN).toBe("secret")
    expect(env.GITHUB_TOKEN_ACME_WIDGETS).toBe("secret")
    expect(env.GITLAB_TOKEN).toBe("secret")
    expect(env.GITLAB_TOKEN_ACME_WIDGETS).toBe("secret")
    expect(env.SQLITE_DATABASE_PATH).toBeUndefined()
    expect(env.KEYMAXXER_SIDECAR_URL).toBeUndefined()
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
