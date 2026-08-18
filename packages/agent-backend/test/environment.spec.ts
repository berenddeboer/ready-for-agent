import {
  HARNESS_OWNED_ENVIRONMENT_NAMES,
  sanitizeInheritedEnvironment,
} from "../src/lib/environment.js"
import { describe, expect, it } from "bun:test"

const HARNESS_OWNED_ENVIRONMENT_NAME_SET = [
  "SQLITE_DATABASE_PATH",
  "KEYMAXXER_SIDECAR_URL",
  "KEYMAXXER_SIDECAR_PORT",
  "KEYMAXXER_ENABLED",
  "KEYMAXXER_MASTER_KEY",
  "KEYMAXXER_APPROVE",
  "READY_FOR_AGENT_GRAPHQL_URL",
] as const

describe("sanitizeInheritedEnvironment", () => {
  it("names the full Harness-owned operational set", () => {
    expect([...HARNESS_OWNED_ENVIRONMENT_NAMES]).toEqual([
      ...HARNESS_OWNED_ENVIRONMENT_NAME_SET,
    ])
  })

  it("always strips Harness-owned operational names", () => {
    const result = sanitizeInheritedEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/op",
      PORT: "3000",
      HOST: "localhost",
      PWD: "/work",
      AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
      CLAUDE_CODE_USE_BEDROCK: "1",
      KEYMAXXER_ENTRYPOINT: "/usr/bin/keymaxxer",
      SQLITE_DATABASE_PATH: "/tmp/ready-for-agent.db",
      KEYMAXXER_SIDECAR_URL: "http://127.0.0.1:6057/cap/mcp",
      KEYMAXXER_SIDECAR_PORT: "6057",
      KEYMAXXER_ENABLED: "true",
      KEYMAXXER_MASTER_KEY: "master",
      KEYMAXXER_APPROVE: "deny",
      READY_FOR_AGENT_GRAPHQL_URL: "http://127.0.0.1:7000/graphql",
    })
    expect(result).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/op",
      PORT: "3000",
      HOST: "localhost",
      PWD: "/work",
      AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
      CLAUDE_CODE_USE_BEDROCK: "1",
      KEYMAXXER_ENTRYPOINT: "/usr/bin/keymaxxer",
    })
  })

  it("strips Harness-owned names even when Forge tokens must remain", () => {
    const result = sanitizeInheritedEnvironment(
      {
        HOME: "/home/op",
        GH_TOKEN: "ambient",
        GITHUB_TOKEN: "ambient-github",
        GITLAB_TOKEN: "ambient-gitlab",
        SQLITE_DATABASE_PATH: "/tmp/ready-for-agent.db",
        KEYMAXXER_SIDECAR_URL: "http://127.0.0.1:6057/cap/mcp",
        KEYMAXXER_MASTER_KEY: "master",
        READY_FOR_AGENT_GRAPHQL_URL: "http://127.0.0.1:7000/graphql",
      },
      { stripForgeTokens: false },
    )
    expect(result).toEqual({
      HOME: "/home/op",
      GH_TOKEN: "ambient",
      GITHUB_TOKEN: "ambient-github",
      GITLAB_TOKEN: "ambient-gitlab",
    })
  })

  it("still strips Forge tokens together with Harness-owned names", () => {
    const result = sanitizeInheritedEnvironment({
      HOME: "/home/op",
      GH_TOKEN: "secret",
      GITHUB_TOKEN: "secret-github",
      GITLAB_TOKEN: "secret-gitlab",
      SQLITE_DATABASE_PATH: "/tmp/ready-for-agent.db",
      KEYMAXXER_SIDECAR_URL: "http://127.0.0.1:6057/cap/mcp",
    })
    expect(result).toEqual({
      HOME: "/home/op",
    })
  })

  it("drops Forge token names by default", () => {
    const result = sanitizeInheritedEnvironment({
      HOME: "/home/user",
      GH_TOKEN: "a",
      GITHUB_TOKEN: "b",
      GITHUB_TOKEN_REPO: "c",
      GITLAB_TOKEN: "d",
      GITLAB_TOKEN_REPO: "e",
      GITLAB_TOKENPROJECT: "f",
      NOT_GITHUB_TOKEN: "keep",
      NOT_GITLAB_TOKEN: "keep-too",
    })
    expect(result).toEqual({
      HOME: "/home/user",
      NOT_GITHUB_TOKEN: "keep",
      NOT_GITLAB_TOKEN: "keep-too",
    })
  })

  it("preserves Forge token names when stripForgeTokens is false", () => {
    const result = sanitizeInheritedEnvironment(
      {
        HOME: "/home/user",
        GH_TOKEN: "a",
        GITHUB_TOKEN: "b",
        GITHUB_TOKEN_REPO: "c",
        GITLAB_TOKEN: "d",
        GITLAB_TOKEN_REPO: "e",
        GITLAB_TOKENPROJECT: "f",
        NOT_GITHUB_TOKEN: "keep",
      },
      { stripForgeTokens: false },
    )
    expect(result).toEqual({
      HOME: "/home/user",
      GH_TOKEN: "a",
      GITHUB_TOKEN: "b",
      GITHUB_TOKEN_REPO: "c",
      GITLAB_TOKEN: "d",
      GITLAB_TOKEN_REPO: "e",
      GITLAB_TOKENPROJECT: "f",
      NOT_GITHUB_TOKEN: "keep",
    })
  })

  it("supports independent Forge token policies", () => {
    expect(
      sanitizeInheritedEnvironment(
        {
          GITHUB_TOKEN: "github",
          GITLAB_TOKEN: "gitlab",
        },
        {
          stripGitHubTokens: true,
          stripGitLabTokens: false,
        },
      ),
    ).toEqual({
      GITLAB_TOKEN: "gitlab",
    })
  })

  it("keeps stripGitHubTokens scoped to GitHub", () => {
    expect(
      sanitizeInheritedEnvironment(
        {
          GITHUB_TOKEN: "github",
          GITLAB_TOKEN: "gitlab",
        },
        { stripGitHubTokens: false },
      ),
    ).toEqual({
      GITHUB_TOKEN: "github",
    })
  })
})
