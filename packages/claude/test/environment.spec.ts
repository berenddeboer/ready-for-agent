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

  it("preserves Bedrock enablement and standard AWS credential chain env vars", () => {
    // Issue #803: operators who export Bedrock/AWS on the harness process
    // must see the same provider behaviour as running Claude themselves.
    const env = makeClaudeEnvironment({
      environment: {
        PATH: "/usr/bin",
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
        AWS_SECRET_ACCESS_KEY: "secret",
        AWS_SESSION_TOKEN: "session",
        AWS_REGION: "us-east-1",
        AWS_DEFAULT_REGION: "us-west-2",
        AWS_PROFILE: "bedrock-op",
        AWS_BEARER_TOKEN_BEDROCK: "bedrock-bearer",
        ANTHROPIC_DEFAULT_SONNET_MODEL:
          "us.anthropic.claude-sonnet-4-20250514-v1:0",
        KEEP: "yes",
      },
    })
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1")
    expect(env.AWS_ACCESS_KEY_ID).toBe("AKIAEXAMPLE")
    expect(env.AWS_SECRET_ACCESS_KEY).toBe("secret")
    expect(env.AWS_SESSION_TOKEN).toBe("session")
    expect(env.AWS_REGION).toBe("us-east-1")
    expect(env.AWS_DEFAULT_REGION).toBe("us-west-2")
    expect(env.AWS_PROFILE).toBe("bedrock-op")
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBe("bedrock-bearer")
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(
      "us.anthropic.claude-sonnet-4-20250514-v1:0",
    )
    expect(env.KEEP).toBe("yes")
    expect(env.DISABLE_AUTOUPDATER).toBe("1")
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
