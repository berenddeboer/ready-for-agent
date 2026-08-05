import { makeClaudeEnvironment } from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("makeClaudeEnvironment", () => {
  it("preserves ambient Forge tokens and Anthropic credentials and disables auto-update", () => {
    const env = makeClaudeEnvironment({
      environment: {
        PATH: "/usr/bin",
        HOME: "/home/op",
        GH_TOKEN: "secret",
        GITHUB_TOKEN: "secret2",
        GITLAB_TOKEN: "secret3",
        GITLAB_TOKEN_ACME_WIDGETS: "secret4",
        ANTHROPIC_API_KEY: "sk-ant-test",
        KEEP: "yes",
      },
    })
    expect(env.PATH).toBe("/usr/bin")
    expect(env.KEEP).toBe("yes")
    expect(env.DISABLE_AUTOUPDATER).toBe("1")
    expect(env.GH_TOKEN).toBe("secret")
    expect(env.GITHUB_TOKEN).toBe("secret2")
    expect(env.GITLAB_TOKEN).toBe("secret3")
    expect(env.GITLAB_TOKEN_ACME_WIDGETS).toBe("secret4")
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test")
  })

  it("forces DISABLE_AUTOUPDATER even when inherited env already sets it", () => {
    const env = makeClaudeEnvironment({
      environment: {
        PATH: "/usr/bin",
        DISABLE_AUTOUPDATER: "0",
      },
    })
    expect(env.DISABLE_AUTOUPDATER).toBe("1")
  })
})
