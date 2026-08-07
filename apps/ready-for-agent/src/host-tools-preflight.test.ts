import { checkHostTools } from "./host-tools-preflight.ts"
import { describe, expect, test } from "bun:test"

describe("host tools preflight", () => {
  test("passes when git, gh, and opencode are present for default backend", () => {
    const result = checkHostTools((command) =>
      ["git", "gh", "opencode"].includes(command),
    )
    expect(result.ok).toBe(true)
  })

  test("requires no Forge tool before the first Repository is added", () => {
    const result = checkHostTools(
      (command) => ["git", "opencode"].includes(command),
      { repositoryForges: [] },
    )
    expect(result.ok).toBe(true)
  })

  test("requires no Agent Backend executable before the first backend selection", () => {
    const result = checkHostTools((command) => command === "git", {
      selectedAgentBackendIds: [],
      repositoryForges: [],
    })

    expect(result).toEqual({ ok: true })
  })

  test("requires gh only when a GitHub Repository exists", () => {
    const githubOnly = checkHostTools(
      (command) => ["git", "gh", "opencode"].includes(command),
      { repositoryForges: ["github"] },
    )
    expect(githubOnly.ok).toBe(true)

    const missing = checkHostTools(
      (command) => ["git", "curl", "opencode"].includes(command),
      { repositoryForges: ["github"] },
    )
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.missing.map((tool) => tool.name)).toEqual(["gh"])
    expect(missing.message).not.toContain("Install curl")
  })

  test("requires curl but not gh when only GitLab Repositories exist", () => {
    const gitlabOnly = checkHostTools(
      (command) => ["git", "curl", "opencode"].includes(command),
      { repositoryForges: ["gitlab"] },
    )
    expect(gitlabOnly.ok).toBe(true)

    const missing = checkHostTools(
      (command) => ["git", "gh", "opencode"].includes(command),
      { repositoryForges: ["gitlab"] },
    )
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.missing.map((tool) => tool.name)).toEqual(["curl"])
    expect(missing.message).toContain("https://curl.se/download.html")
    expect(missing.message).not.toContain("Install GitHub CLI")
    expect(missing.message).not.toContain("glab")
  })

  test("requires both Forge tools for a mixed Repository fleet", () => {
    const result = checkHostTools(
      (command) => ["git", "gh", "curl", "opencode"].includes(command),
      { repositoryForges: ["gitlab", "github"] },
    )
    expect(result.ok).toBe(true)
  })

  test("requires grok instead of opencode when only Grok Build is selected", () => {
    const withGrok = checkHostTools(
      (command) => ["git", "gh", "grok"].includes(command),
      { selectedAgentBackendIds: ["grok"] },
    )
    expect(withGrok.ok).toBe(true)

    const missingGrok = checkHostTools(
      (command) => ["git", "gh", "opencode"].includes(command),
      { selectedAgentBackendIds: ["grok"] },
    )
    expect(missingGrok.ok).toBe(false)
    if (missingGrok.ok) return
    expect(missingGrok.missing.map((tool) => tool.name)).toEqual(["grok"])
    expect(missingGrok.message).toContain("grok")
    expect(missingGrok.message).not.toContain("opencode")
  })

  test("default only when no overrides: unused built-ins are not required", () => {
    const result = checkHostTools(
      (command) => ["git", "gh", "opencode"].includes(command),
      { selectedAgentBackendIds: ["opencode"] },
    )
    expect(result.ok).toBe(true)
  })

  test("union includes override backends: both binaries required", () => {
    const bothPresent = checkHostTools(
      (command) => ["git", "gh", "opencode", "grok"].includes(command),
      { selectedAgentBackendIds: ["opencode", "grok"] },
    )
    expect(bothPresent.ok).toBe(true)

    const missingGrok = checkHostTools(
      (command) => ["git", "gh", "opencode"].includes(command),
      { selectedAgentBackendIds: ["opencode", "grok"] },
    )
    expect(missingGrok.ok).toBe(false)
    if (missingGrok.ok) return
    expect(missingGrok.missing.map((tool) => tool.name)).toEqual(["grok"])
    expect(missingGrok.message).toContain("grok")
    expect(missingGrok.message).toContain("OpenCode")
    expect(missingGrok.message).toContain("Grok Build")
  })

  test("unused built-ins not required when a single backend is selected", () => {
    const onlyGrok = checkHostTools(
      (command) => ["git", "gh", "grok"].includes(command),
      { selectedAgentBackendIds: ["grok"] },
    )
    expect(onlyGrok.ok).toBe(true)

    const onlyOpenCode = checkHostTools(
      (command) => ["git", "gh", "opencode"].includes(command),
      { selectedAgentBackendIds: ["opencode"] },
    )
    expect(onlyOpenCode.ok).toBe(true)
  })

  test("requires codex when only Codex Build is selected", () => {
    const withCodex = checkHostTools(
      (command) => ["git", "gh", "codex"].includes(command),
      { selectedAgentBackendIds: ["codex"] },
    )
    expect(withCodex.ok).toBe(true)

    const missingCodex = checkHostTools(
      (command) => ["git", "gh", "opencode"].includes(command),
      { selectedAgentBackendIds: ["codex"] },
    )
    expect(missingCodex.ok).toBe(false)
    if (missingCodex.ok) return
    expect(missingCodex.missing.map((tool) => tool.name)).toEqual(["codex"])
    expect(missingCodex.message).toContain("codex")
    expect(missingCodex.message).toContain("Codex Build")
  })

  test("requires claude when only Claude Code is selected", () => {
    const withClaude = checkHostTools(
      (command) => ["git", "gh", "claude"].includes(command),
      { selectedAgentBackendIds: ["claude"] },
    )
    expect(withClaude.ok).toBe(true)

    const missingClaude = checkHostTools(
      (command) => ["git", "gh", "opencode"].includes(command),
      { selectedAgentBackendIds: ["claude"] },
    )
    expect(missingClaude.ok).toBe(false)
    if (missingClaude.ok) return
    expect(missingClaude.missing.map((tool) => tool.name)).toEqual(["claude"])
    expect(missingClaude.message).toContain("claude")
    expect(missingClaude.message).toContain("Claude Code")
    expect(missingClaude.message).toContain(
      "https://docs.anthropic.com/en/docs/claude-code",
    )
    expect(missingClaude.message).not.toContain("opencode")
  })

  test("does not require AWS CLI for Claude Code / Bedrock profile discovery (issue #822)", () => {
    // Bedrock inference-profile listing uses the bundled AWS SDK, not `aws` on PATH.
    const seen = new Set<string>()
    const withClaudeNoAws = checkHostTools(
      (command) => {
        seen.add(command)
        return ["git", "gh", "claude"].includes(command)
      },
      { selectedAgentBackendIds: ["claude"] },
    )
    expect(withClaudeNoAws.ok).toBe(true)
    expect(seen.has("aws")).toBe(false)
    expect(seen.has("aws-cli")).toBe(false)

    // Even when every tool except aws is present for Claude, preflight must not
    // invent an aws requirement.
    const onlyAwsMissing = checkHostTools(
      (command) => command !== "aws" && command !== "aws-cli",
      { selectedAgentBackendIds: ["claude"] },
    )
    expect(onlyAwsMissing.ok).toBe(true)
  })

  test("passes without keymaxxer", () => {
    const result = checkHostTools((command) =>
      ["git", "gh", "opencode"].includes(command),
    )
    expect(result.ok).toBe(true)
  })

  test("fails with install hints when required tools are missing", () => {
    const result = checkHostTools((command) => command === "git")
    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.missing.map((tool) => tool.name)).toEqual(["gh", "opencode"])
    expect(result.message).toContain("gh")
    expect(result.message).toContain("https://cli.github.com/")
    expect(result.message).toContain("opencode")
    expect(result.message).toContain("https://opencode.ai")
    expect(result.message).toContain("Keymaxxer is optional")
  })

  test("does not fail solely because keymaxxer is missing", () => {
    const result = checkHostTools((command) =>
      ["git", "gh", "opencode"].includes(command),
    )
    expect(result).toEqual({ ok: true })
  })

  test("still accepts singular selectedAgentBackendId", () => {
    const result = checkHostTools(
      (command) => ["git", "gh", "grok"].includes(command),
      { selectedAgentBackendId: "grok" },
    )
    expect(result.ok).toBe(true)
  })

  test("empty selectedAgentBackendIds still honors singular id", () => {
    const result = checkHostTools(
      (command) => ["git", "gh", "grok"].includes(command),
      { selectedAgentBackendIds: [], selectedAgentBackendId: "grok" },
    )
    expect(result.ok).toBe(true)
  })
})
