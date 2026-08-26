import {
  checkHostTools,
  keymaxxerCanResolveVault,
} from "./host-tools-preflight.ts"
import { describe, expect, test } from "bun:test"

describe("host tools preflight", () => {
  test("requires only git before the first Repository is added", () => {
    expect(
      checkHostTools((command) => command === "git", {
        repositoryForges: [],
      }),
    ).toEqual({ ok: true })
  })

  test("never inspects Agent Backend executables", () => {
    const inspected: string[] = []
    const result = checkHostTools(
      (command) => {
        inspected.push(command)
        return command === "git"
      },
      { repositoryForges: [] },
    )

    expect(result).toEqual({ ok: true })
    expect(inspected).toEqual(["git"])
  })

  test("requires gh only when a GitHub Repository exists", () => {
    const githubOnly = checkHostTools(
      (command) => ["git", "gh"].includes(command),
      { repositoryForges: ["github"] },
    )
    expect(githubOnly.ok).toBe(true)

    const missing = checkHostTools(
      (command) => ["git", "glab", "curl"].includes(command),
      { repositoryForges: ["github"] },
    )
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.missing.map((tool) => tool.name)).toEqual(["gh"])
    expect(missing.message).not.toContain("glab")
    expect(missing.message).not.toContain("curl")
  })

  test("requires glab but not gh or curl when only GitLab Repositories exist", () => {
    const gitlabOnly = checkHostTools(
      (command) => ["git", "glab"].includes(command),
      { repositoryForges: ["gitlab"] },
    )
    expect(gitlabOnly.ok).toBe(true)

    const missing = checkHostTools(
      (command) => ["git", "gh", "curl"].includes(command),
      { repositoryForges: ["gitlab"] },
    )
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.missing.map((tool) => tool.name)).toEqual(["glab"])
    expect(missing.message).toContain("https://docs.gitlab.com/cli/")
    expect(missing.message).not.toContain("Install GitHub CLI")
    expect(missing.message).not.toContain("curl")
  })

  test("requires both Forge tools for a mixed Repository fleet", () => {
    expect(
      checkHostTools((command) => ["git", "gh", "glab"].includes(command), {
        repositoryForges: ["gitlab", "github"],
      }),
    ).toEqual({ ok: true })

    const missing = checkHostTools((command) => command === "git", {
      repositoryForges: ["github", "gitlab"],
    })
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.missing.map((tool) => tool.name)).toEqual(["gh", "glab"])
    expect(missing.message).not.toContain("curl")
  })

  test("fails with install hints only for required base and Forge tools", () => {
    const result = checkHostTools(() => false)
    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.missing.map((tool) => tool.name)).toEqual(["git", "gh"])
    expect(result.message).toContain("https://git-scm.com/downloads")
    expect(result.message).toContain("https://cli.github.com/")
    expect(result.message).not.toContain("opencode")
    expect(result.message).toContain("never block the Harness UI")
    expect(result.message).toContain("Keymaxxer is optional")
  })

  test("requires no PATH tool for Azure DevOps but does require the PAT env var", () => {
    const withPat = checkHostTools((command) => command === "git", {
      repositoryForges: ["azure-devops"],
      hasEnvVar: () => true,
    })
    expect(withPat).toEqual({ ok: true })

    const withoutPat = checkHostTools((command) => command === "git", {
      repositoryForges: ["azure-devops"],
      hasEnvVar: () => false,
    })
    expect(withoutPat.ok).toBe(false)
    if (withoutPat.ok) return
    expect(withoutPat.missing.map((tool) => tool.name)).toEqual([
      "AZURE_DEVOPS_EXT_PAT",
    ])
    expect(withoutPat.message).toContain("AZURE_DEVOPS_EXT_PAT")
    expect(withoutPat.message).toContain("docs/forge-token-scopes.md")
    expect(withoutPat.message).not.toContain("gh:")
    expect(withoutPat.message).not.toContain("glab:")
  })

  test("allows Azure DevOps start without the ambient PAT when Keymaxxer is enabled", () => {
    const vaultOnly = checkHostTools((command) => command === "git", {
      repositoryForges: ["azure-devops"],
      hasEnvVar: () => false,
      keymaxxerEnabled: true,
    })
    expect(vaultOnly).toEqual({ ok: true })
  })

  test("still fails closed for Azure DevOps when neither vault nor ambient PAT can resolve", () => {
    const missing = checkHostTools((command) => command === "git", {
      repositoryForges: ["azure-devops"],
      hasEnvVar: () => false,
      keymaxxerEnabled: false,
    })
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.missing.map((tool) => tool.name)).toEqual([
      "AZURE_DEVOPS_EXT_PAT",
    ])
  })

  test("keymaxxerCanResolveVault requires a sidecar URL or an available Keymaxxer", () => {
    expect(
      keymaxxerCanResolveVault({ KEYMAXXER_ENABLED: "false" }, () => true),
    ).toBe(false)
    expect(
      keymaxxerCanResolveVault(
        { KEYMAXXER_SIDECAR_URL: "http://127.0.0.1:6057/cap/mcp" },
        () => false,
      ),
    ).toBe(true)
    expect(keymaxxerCanResolveVault({}, () => true)).toBe(true)
    expect(keymaxxerCanResolveVault({}, () => false)).toBe(false)
    expect(
      keymaxxerCanResolveVault(
        {
          KEYMAXXER_ENABLED: "false",
          KEYMAXXER_SIDECAR_URL: "http://127.0.0.1:6057/cap/mcp",
        },
        () => true,
      ),
    ).toBe(false)
  })

  test("requires all three Forge requirements for a mixed fleet", () => {
    const missing = checkHostTools(
      (command) => ["git", "gh", "glab"].includes(command),
      {
        repositoryForges: ["github", "gitlab", "azure-devops"],
        hasEnvVar: () => false,
      },
    )
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.missing.map((tool) => tool.name)).toEqual([
      "AZURE_DEVOPS_EXT_PAT",
    ])

    const allSatisfied = checkHostTools(
      (command) => ["git", "gh", "glab"].includes(command),
      {
        repositoryForges: ["github", "gitlab", "azure-devops"],
        hasEnvVar: () => true,
      },
    )
    expect(allSatisfied).toEqual({ ok: true })
  })
})
