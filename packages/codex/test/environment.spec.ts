import { makeCodexEnvironment } from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("makeCodexEnvironment", () => {
  it("preserves ambient GitHub tokens and OpenAI credentials", () => {
    const env = makeCodexEnvironment({
      environment: {
        PATH: "/usr/bin",
        HOME: "/home/op",
        GH_TOKEN: "secret",
        GITHUB_TOKEN: "secret2",
        OPENAI_API_KEY: "sk-test",
        KEEP: "yes",
      },
    })
    expect(env.PATH).toBe("/usr/bin")
    expect(env.KEEP).toBe("yes")
    expect(env.GH_TOKEN).toBe("secret")
    expect(env.GITHUB_TOKEN).toBe("secret2")
    expect(env.OPENAI_API_KEY).toBe("sk-test")
  })
})
