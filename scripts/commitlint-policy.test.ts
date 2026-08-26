import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { describe, expect, it } from "bun:test"

const workspaceRoot = join(import.meta.dir, "..")

const longLine = (prefix: string, filler: string): string => {
  const pad = filler.repeat(120)
  return `${prefix}${pad}`.slice(0, 120)
}

const lint = (message: string) =>
  spawnSync("bun", ["run", "commitlint"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    input: `${message}\n`,
  })

describe("repository Commitlint policy", () => {
  it("accepts publication bodies with lines longer than 100 characters", () => {
    const result = lint(
      [
        "feat: cache the widgets list endpoint",
        "",
        longLine(
          "Adds cached widgets responses so the dashboard reuses prior results. ",
          "x",
        ),
        "",
        "Closes #1221",
      ].join("\n"),
    )
    expect(result.status, result.stdout + result.stderr).toBe(0)
  })

  it("accepts publication footers with lines longer than 100 characters", () => {
    const result = lint(
      [
        "feat: cache the widgets list endpoint",
        "",
        "Adds cached widgets responses used by the dashboard.",
        "",
        longLine(
          "BREAKING CHANGE: clients must send If-None-Match on widgets list. ",
          "y",
        ),
      ].join("\n"),
    )
    expect(result.status, result.stdout + result.stderr).toBe(0)
  })

  it("rejects an invalid Conventional Commit type", () => {
    const result = lint(
      [
        "ship: cache the widgets list endpoint",
        "",
        "Adds cached widgets responses used by the dashboard.",
      ].join("\n"),
    )
    expect(result.status).not.toBe(0)
    expect(result.stdout + result.stderr).toMatch(/type-enum/)
  })

  it("rejects ci as a Conventional Commit scope", () => {
    const result = lint(
      [
        "feat(ci): cache the widgets list endpoint",
        "",
        "Adds cached widgets responses used by the dashboard.",
      ].join("\n"),
    )
    expect(result.status).not.toBe(0)
    expect(result.stdout + result.stderr).toMatch(/scope-not-ci/)
  })
})
