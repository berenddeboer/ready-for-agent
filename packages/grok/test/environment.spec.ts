import { makeGrokEnvironment } from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("makeGrokEnvironment", () => {
  it("preserves ambient GitHub tokens and disables auto-update", () => {
    const env = makeGrokEnvironment({
      environment: {
        PATH: "/usr/bin",
        HOME: "/home/op",
        GH_TOKEN: "secret",
        GITHUB_TOKEN: "secret2",
        GITHUB_TOKEN_repo: "secret3",
        KEEP: "yes",
      },
    })
    expect(env.PATH).toBe("/usr/bin")
    expect(env.KEEP).toBe("yes")
    expect(env.GROK_DISABLE_AUTOUPDATER).toBe("1")
    expect(env.GH_TOKEN).toBe("secret")
    expect(env.GITHUB_TOKEN).toBe("secret2")
    expect(env.GITHUB_TOKEN_repo).toBe("secret3")
    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined()
  })
})
