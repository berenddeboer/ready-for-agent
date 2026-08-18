import { jumpPaneEnvironmentFlags } from "./jump-pane-environment.ts"
import { afterEach, describe, expect, test } from "bun:test"

const assignedNames = (flags: readonly string[]): string[] => {
  const names: string[] = []
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] !== "-e") {
      continue
    }
    const assignment = flags[i + 1]
    if (assignment !== undefined) {
      names.push(assignment.split("=")[0] ?? assignment)
    }
    i += 1
  }
  return names
}

describe("jumpPaneEnvironmentFlags", () => {
  const previous: Record<string, string | undefined> = {}
  const overrideNames = [
    "CLAUDE_CODE_USE_BEDROCK",
    "SQLITE_DATABASE_PATH",
    "KEYMAXXER_SIDECAR_URL",
    "KEYMAXXER_SIDECAR_PORT",
    "KEYMAXXER_ENABLED",
    "KEYMAXXER_MASTER_KEY",
    "KEYMAXXER_APPROVE",
    "READY_FOR_AGENT_GRAPHQL_URL",
    "KEYMAXXER_ENTRYPOINT",
    "GH_TOKEN",
  ] as const

  afterEach(() => {
    for (const name of overrideNames) {
      const value = previous[name]
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
      delete previous[name]
    }
  })

  test("strips Harness-owned names and keeps operator tooling and ambient Forge tokens", () => {
    for (const name of overrideNames) {
      previous[name] = process.env[name]
    }
    process.env.CLAUDE_CODE_USE_BEDROCK = "1"
    process.env.SQLITE_DATABASE_PATH = "/tmp/ready-for-agent.db"
    process.env.KEYMAXXER_SIDECAR_URL = "http://127.0.0.1:6057/cap/mcp"
    process.env.KEYMAXXER_SIDECAR_PORT = "6057"
    process.env.KEYMAXXER_ENABLED = "true"
    process.env.KEYMAXXER_MASTER_KEY = "master"
    process.env.KEYMAXXER_APPROVE = "deny"
    process.env.READY_FOR_AGENT_GRAPHQL_URL = "http://127.0.0.1:7000/graphql"
    process.env.KEYMAXXER_ENTRYPOINT = "/usr/bin/keymaxxer"
    process.env.GH_TOKEN = "ambient"

    const names = assignedNames(
      jumpPaneEnvironmentFlags({ backendId: "opencode" }),
    )
    expect(names).toContain("CLAUDE_CODE_USE_BEDROCK")
    expect(names).toContain("KEYMAXXER_ENTRYPOINT")
    expect(names).toContain("GH_TOKEN")
    expect(names).not.toContain("SQLITE_DATABASE_PATH")
    expect(names).not.toContain("KEYMAXXER_SIDECAR_URL")
    expect(names).not.toContain("KEYMAXXER_SIDECAR_PORT")
    expect(names).not.toContain("KEYMAXXER_ENABLED")
    expect(names).not.toContain("KEYMAXXER_MASTER_KEY")
    expect(names).not.toContain("KEYMAXXER_APPROVE")
    expect(names).not.toContain("READY_FOR_AGENT_GRAPHQL_URL")
  })
})
