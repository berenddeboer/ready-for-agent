/**
 * Cohesive Usage quality gate: one Nx target covers lint, Effect parity,
 * generated-document drift, and completion behavior; CI can reproduce it
 * locally without bundling Usage into published packages.
 */

import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "bun:test"

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const workspaceRoot = resolve(appRoot, "../..")

const PLATFORM_PACKAGES = [
  "ready-for-agent-linux-x64",
  "ready-for-agent-linux-arm64",
  "ready-for-agent-darwin-x64",
  "ready-for-agent-darwin-arm64",
  "ready-for-agent-win32-x64",
  "ready-for-agent-win32-arm64",
] as const

type Target = {
  readonly executor?: string
  readonly command?: string
  readonly cache?: boolean
  readonly inputs?: unknown[]
  readonly outputs?: unknown[]
  readonly dependsOn?: unknown[]
  readonly options?: {
    readonly command?: string
    readonly cwd?: string
  }
}

type ProjectJson = {
  readonly targets: Record<string, Target>
}

const project = JSON.parse(
  readFileSync(join(appRoot, "project.json"), "utf8"),
) as ProjectJson

const targetCommand = (target: Target | undefined): string =>
  target?.options?.command ?? target?.command ?? ""

const dependsOnNames = (target: Target | undefined): readonly string[] =>
  (target?.dependsOn ?? []).flatMap((entry) => {
    if (typeof entry === "string") {
      return [entry]
    }
    return []
  })

const inputText = (target: Target | undefined): string =>
  JSON.stringify(target?.inputs ?? [])

describe("ready-for-agent Usage quality gate", () => {
  test("exposes one check-usage target for lint, parity, docs, and completions", () => {
    const gate = project.targets["check-usage"]
    expect(gate).toBeDefined()
    expect(gate?.cache).toBe(true)

    const deps = dependsOnNames(gate)
    expect(deps).toEqual(
      expect.arrayContaining([
        "lint-usage",
        "check-usage-docs",
        "check-usage-parity",
        "check-usage-completions",
      ]),
    )
    expect(deps).toHaveLength(4)

    expect(targetCommand(project.targets["lint-usage"])).toContain(
      "lint --warnings-as-errors",
    )
    expect(targetCommand(project.targets["check-usage-docs"])).toContain(
      "scripts/update-usage-docs.ts --check",
    )
    expect(targetCommand(project.targets["check-usage-parity"])).toContain(
      "src/cli-usage-parity.test.ts",
    )
    expect(targetCommand(project.targets["check-usage-completions"])).toContain(
      "src/generate-usage-completions.test.ts",
    )

    expect(dependsOnNames(project.targets["check-usage-parity"])).toEqual(
      expect.arrayContaining(["generate-embed"]),
    )
    expect(dependsOnNames(project.targets["check-usage-completions"])).toEqual(
      expect.arrayContaining(["generate-embed"]),
    )

    expect(inputText(gate)).toContain("README.md")
    expect(inputText(gate)).toContain("ready-for-agent.usage.kdl")
    expect(inputText(gate)).toContain("run-pinned-usage.sh")
    expect(inputText(gate)).toContain("mise.toml")
    expect(inputText(gate)).toContain("CONTRIBUTING.md")

    expect(inputText(project.targets["check-usage-docs"])).toContain(
      "README.md",
    )
    expect(inputText(project.targets["check-usage-completions"])).toContain(
      "CONTRIBUTING.md",
    )
    expect(project.targets["check-usage-docs"]?.outputs ?? []).not.toContain(
      "{workspaceRoot}/README.md",
    )
  })

  test("unit tests go through the same Usage gate as CI", () => {
    expect(dependsOnNames(project.targets.test)).toEqual(
      expect.arrayContaining(["check-usage"]),
    )
    expect(dependsOnNames(project.targets.test)).not.toEqual(
      expect.arrayContaining(["lint-usage", "check-usage-docs"]),
    )
    expect(inputText(project.targets.test)).toContain("README.md")
    expect(inputText(project.targets.test)).toContain("CONTRIBUTING.md")
  })

  test("maintainer docs name the single local command that reproduces CI", () => {
    const contributing = readFileSync(
      join(workspaceRoot, "CONTRIBUTING.md"),
      "utf8",
    )
    expect(contributing).toMatch(
      /bunx nx run ready-for-agent:check-usage(?![-a-z])/,
    )
    expect(contributing).toMatch(/CI Usage (quality )?gate/i)
    expect(contributing).not.toMatch(
      /`bunx nx run ready-for-agent:test` runs that check \(and `lint-usage`\) first/,
    )
  })

  test("published launcher and platform packages do not depend on Usage", () => {
    const launcher = JSON.parse(
      readFileSync(join(appRoot, "package.json"), "utf8"),
    ) as {
      readonly dependencies?: Record<string, string>
      readonly devDependencies?: Record<string, string>
      readonly optionalDependencies?: Record<string, string>
      readonly files?: readonly string[]
    }
    expect(launcher.dependencies ?? {}).not.toHaveProperty("usage")
    expect(launcher.devDependencies ?? {}).not.toHaveProperty("usage")
    expect(launcher.optionalDependencies ?? {}).not.toHaveProperty("usage")
    expect(launcher.files).not.toContain("ready-for-agent.usage.kdl")

    for (const name of PLATFORM_PACKAGES) {
      const pkg = JSON.parse(
        readFileSync(
          join(workspaceRoot, "packages", name, "package.json"),
          "utf8",
        ),
      ) as {
        readonly dependencies?: Record<string, string>
        readonly files?: readonly string[]
      }
      expect(pkg.dependencies ?? {}, name).toEqual({})
      expect(pkg.files, name).not.toContain("ready-for-agent.usage.kdl")
    }
  })

  test("compiled-host and packed-install seams still emit the Usage contract", () => {
    const hostBinary = readFileSync(
      join(appRoot, "src/host-binary.test.ts"),
      "utf8",
    )
    expect(hostBinary).toContain("--usage")
    expect(hostBinary).toContain("emits the embedded Usage contract")

    const packedInstall = readFileSync(
      join(appRoot, "scripts/packed-install-smoke.ts"),
      "utf8",
    )
    expect(packedInstall).toContain('["--usage"]')
    expect(packedInstall).toContain("checked-in Usage KDL contract")
  })
})
