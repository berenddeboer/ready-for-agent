import { makeGrokEnvironment } from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("makeGrokEnvironment", () => {
  it("preserves ambient Forge tokens and disables auto-update", () => {
    const env = makeGrokEnvironment({
      environment: {
        PATH: "/usr/bin",
        HOME: "/home/op",
        GH_TOKEN: "secret",
        GITHUB_TOKEN: "secret2",
        GITHUB_TOKEN_repo: "secret3",
        GITLAB_TOKEN: "secret4",
        GITLAB_TOKEN_repo: "secret5",
        SQLITE_DATABASE_PATH: "/tmp/ready-for-agent.db",
        KEYMAXXER_SIDECAR_URL: "http://127.0.0.1:6057/cap/mcp",
        KEEP: "yes",
      },
    })
    expect(env.PATH).toBe("/usr/bin")
    expect(env.KEEP).toBe("yes")
    expect(env.GROK_DISABLE_AUTOUPDATER).toBe("1")
    expect(env.GH_TOKEN).toBe("secret")
    expect(env.GITHUB_TOKEN).toBe("secret2")
    expect(env.GITHUB_TOKEN_repo).toBe("secret3")
    expect(env.GITLAB_TOKEN).toBe("secret4")
    expect(env.GITLAB_TOKEN_repo).toBe("secret5")
    expect(env.SQLITE_DATABASE_PATH).toBeUndefined()
    expect(env.KEYMAXXER_SIDECAR_URL).toBeUndefined()
    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined()
  })
})
