import { checkHostTools } from "./host-tools-preflight.ts"
import { describe, expect, test } from "bun:test"

describe("host tools preflight", () => {
  test("passes when git, gh, and opencode are present for default backend", () => {
    const result = checkHostTools((command) =>
      ["git", "gh", "opencode"].includes(command),
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

  test("unused built-ins not required even when only one of two is selected", () => {
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
