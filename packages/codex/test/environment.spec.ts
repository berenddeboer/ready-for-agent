import { makeCodexEnvironment } from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("makeCodexEnvironment", () => {
  it("preserves ambient Forge tokens and OpenAI credentials", () => {
    const env = makeCodexEnvironment({
      environment: {
        PATH: "/usr/bin",
        HOME: "/home/op",
        GH_TOKEN: "secret",
        GITHUB_TOKEN: "secret2",
        GITLAB_TOKEN: "secret3",
        GITLAB_TOKEN_ACME_WIDGETS: "secret4",
        OPENAI_API_KEY: "sk-test",
        SQLITE_DATABASE_PATH: "/tmp/ready-for-agent.db",
        KEEP: "yes",
      },
    })
    expect(env.PATH).toBe("/usr/bin")
    expect(env.KEEP).toBe("yes")
    expect(env.GH_TOKEN).toBe("secret")
    expect(env.GITHUB_TOKEN).toBe("secret2")
    expect(env.GITLAB_TOKEN).toBe("secret3")
    expect(env.GITLAB_TOKEN_ACME_WIDGETS).toBe("secret4")
    expect(env.OPENAI_API_KEY).toBe("sk-test")
    expect(env.SQLITE_DATABASE_PATH).toBeUndefined()
  })
})
