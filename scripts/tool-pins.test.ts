import { spawnSync } from "node:child_process"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "bun:test"

const workspaceRoot = join(import.meta.dir, "..")

const readWorkspace = (relativePath: string): string =>
  readFileSync(join(workspaceRoot, relativePath), "utf8")

const quotedAssignment = (source: string, key: string): string | undefined =>
  source.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"))?.[1]

const tomlTable = (source: string, heading: string): string | undefined => {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const start = source.search(new RegExp(`^\\[${escaped}\\]\\s*$`, "m"))
  if (start < 0) {
    return undefined
  }
  const afterHeading = source.indexOf("\n", start)
  const rest = afterHeading < 0 ? "" : source.slice(afterHeading + 1)
  const end = rest.search(/^\[[^\]]+\]\s*$/m)
  return end < 0 ? rest : rest.slice(0, end)
}

const githubYamlFiles = (): readonly string[] => {
  const files: string[] = []
  const visit = (relativeDir: string) => {
    for (const entry of readdirSync(join(workspaceRoot, relativeDir), {
      withFileTypes: true,
    })) {
      const relativePath = `${relativeDir}/${entry.name}`
      if (entry.isDirectory()) {
        visit(relativePath)
        continue
      }
      if (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml")) {
        files.push(relativePath)
      }
    }
  }
  visit(".github")
  return files
}

describe("contributor environment pins", () => {
  const miseToml = readWorkspace("mise.toml")
  const hkPkl = readWorkspace("hk.pkl")

  it("declares concrete Bun, hk, and Usage pins in mise.toml without machine-global bootstrap packages", () => {
    const bunVersion = quotedAssignment(miseToml, "bun")
    expect(bunVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(quotedAssignment(miseToml, "min_version")).toBe("2026.7.0")
    expect(quotedAssignment(miseToml, "hk")).toMatch(/^\d+\.\d+\.\d+$/)
    expect(quotedAssignment(miseToml, "usage")).toBe("5.1.0")
    expect(miseToml).not.toContain("[bootstrap.packages]")
  })

  it("keeps the hk pin aligned with the hk.pkl package URL", () => {
    const hkVersion = quotedAssignment(miseToml, "hk")
    expect(hkVersion).toBeDefined()
    expect(hkPkl).toContain(
      `package://github.com/jdx/hk/releases/download/v${hkVersion}/hk@${hkVersion}`,
    )
  })

  it("re-applies the nested TypeScript shim after the lockfile-only hook step", () => {
    expect(hkPkl).toContain("scripts/fix-bun-typescript-for-nx.mjs")
    expect(hkPkl).toContain("export NX_DAEMON=false")
  })

  it("declares bootstrap as bun install and setup-e2e as Harness Playwright Chromium", () => {
    const bootstrap = tomlTable(miseToml, "tasks.bootstrap")
    expect(bootstrap).toBeDefined()
    expect(quotedAssignment(bootstrap!, "run")).toBe("bun install")

    const setupE2e = tomlTable(miseToml, "tasks.setup-e2e")
    expect(setupE2e).toBeDefined()
    expect(quotedAssignment(setupE2e!, "run")).toBe(
      "bunx playwright install --with-deps chromium",
    )
    expect(quotedAssignment(setupE2e!, "dir")).toContain("apps/harness")
  })

  it("uses the mise.toml Bun pin in every GitHub Actions Bun setup", () => {
    const bunVersion = quotedAssignment(miseToml, "bun")
    expect(bunVersion).toBeDefined()

    const setupBunBlocks: string[] = []
    for (const relativePath of githubYamlFiles()) {
      const contents = readWorkspace(relativePath)
      expect(contents, relativePath).not.toMatch(/bun-version:\s*latest\b/)

      const uses = contents.matchAll(
        /uses:\s*oven-sh\/setup-bun@[^\n]+\n(?:[ \t]+[^\n]*\n)*/g,
      )
      for (const match of uses) {
        setupBunBlocks.push(`${relativePath}:\n${match[0]}`)
      }
    }

    expect(setupBunBlocks.length).toBeGreaterThan(0)
    for (const block of setupBunBlocks) {
      expect(block).toMatch(
        new RegExp(`bun-version:\\s*["']?${bunVersion}["']?`),
      )
    }
  })

  it("installs the mise.toml Usage pin in quality-gate workflows", () => {
    const usageVersion = quotedAssignment(miseToml, "usage")
    expect(usageVersion).toBe("5.1.0")
    const wrapper = spawnSync(
      "bash",
      [join(workspaceRoot, "scripts", "run-pinned-usage.sh"), "--version"],
      { encoding: "utf8" },
    )
    expect(wrapper.status, wrapper.stderr).toBe(0)
    expect(wrapper.stdout.trim()).toBe(`usage-cli ${usageVersion}`)

    const qualityGateFiles = [
      ".github/workflows/pr.yml",
      ".github/workflows/ci-cd.yml",
    ] as const
    for (const relativePath of qualityGateFiles) {
      const contents = readWorkspace(relativePath)
      expect(contents, relativePath).toContain(`VERSION=${usageVersion}`)
      expect(contents, relativePath).toContain("jdx/usage/releases/download/v")
      expect(contents, relativePath).toContain(
        "usage-x86_64-unknown-linux-musl.tar.gz",
      )
      expect(contents, relativePath).not.toMatch(/usage-cli@latest/i)
    }
  })
})
