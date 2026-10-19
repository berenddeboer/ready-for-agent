import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { EXPECTED_OPENCODE_CLI_CONTRACT_CASES } from "./run-opencode-cli-contract.ts"
import { describe, expect, it } from "bun:test"

const workspaceRoot = join(import.meta.dir, "..")

const read = (relativePath: string): string =>
  readFileSync(join(workspaceRoot, relativePath), "utf8")

const jobBody = (workflow: string, job: string): string => {
  const start = workflow.indexOf(`\n  ${job}:`)
  expect(start).toBeGreaterThan(0)
  const rest = workflow.slice(start + 1)
  const next = rest.slice(1).search(/\n {2}[a-z0-9-]+:/)
  return next < 0 ? rest : rest.slice(0, next + 1)
}

const contractCases = (relativePath: string): number => {
  const source = read(relativePath)
  expect(source).not.toMatch(/^\s*(?:test|it)\.(?:skip|only|todo)\(/m)
  return [...source.matchAll(/^\s*(?:test|it)\(/gm)].length
}

describe("OpenCode contract CI wiring", () => {
  const pr = read(".github/workflows/pr.yml")
  const cicd = read(".github/workflows/ci-cd.yml")
  const drift = read(".github/workflows/opencode-cli-contract-drift.yml")
  const project = read("packages/opencode/project.json")
  const mise = read("mise.toml")

  it("pins the incident baseline without making mise switch the binary", () => {
    expect(mise).toContain('OPENCODE_V2_BASELINE = "2.0.32"')
    const tools = mise.slice(
      mise.indexOf("[tools]"),
      mise.indexOf("[tasks.bootstrap]"),
    )
    expect(tools).not.toMatch(/^opencode\s*=/m)
  })

  it("keeps the Nx target uncached and pointed at the production suite", () => {
    expect(project).toContain('"cache": false')
    expect(project).toContain("scripts/run-opencode-cli-contract.ts")
    expect(project).not.toContain("nx affected")
    expect(project).toContain("apps/ready-for-agent/src/**/*.ts")
    expect(project).toContain(".github/workflows/pr.yml")
    expect(project).toContain("opencode-cli-contract-drift.yml")
  })

  it("requires the same unskipped job on PR and main, without secrets", () => {
    for (const workflow of [pr, cicd]) {
      const job = jobBody(workflow, "opencode-cli-contract")
      expect(job).toContain("install-opencode-v2.sh baseline")
      expect(job).toContain("bunx nx run opencode:cli-contract --skip-nx-cache")
      expect(job).toContain("OPENCODE_CONTRACT_MODE: baseline")
      expect(job).toContain("upload-artifact")
      expect(job).not.toContain("secrets.")
      expect(job).not.toContain("continue-on-error")
      expect(job).not.toContain("nx affected")
      expect(job).toContain("--skip-nx-cache")
      expect(job).not.toContain("uses: ./.github/actions/nx-cache")
      expect(job.replaceAll("if: always()", "")).not.toMatch(/\n\s+if:/)
    }
    expect(pr).not.toMatch(/pull_request:\s*\n\s+paths:/)
    expect(cicd).not.toMatch(/push:\s*\n\s+paths:/)
    expect(cicd).toContain(
      "needs: [quality-gates, harness, packed-install, pinact, jactionlint, opencode-cli-contract]",
    )
  })

  it("schedules latest stable coverage as drift, not as the required pin", () => {
    expect(drift).toContain("schedule:")
    expect(drift).toContain("install-opencode-v2.sh latest")
    expect(drift).toContain("OPENCODE_CONTRACT_MODE: latest")
    expect(drift).toContain("bunx nx run opencode:cli-contract --skip-nx-cache")
    expect(drift).not.toContain("secrets.")
    expect(drift).not.toContain("continue-on-error")
    expect(drift).not.toContain("uses: ./.github/actions/nx-cache")
    const job = jobBody(drift, "opencode-cli-contract-latest")
    expect(job.replaceAll("if: always()", "")).not.toMatch(/\n\s+if:/)
  })

  it("locks the expected case count to the inventoried suite files", () => {
    const cases =
      contractCases("packages/opencode/test/v2-cli-contract.spec.ts") +
      contractCases(
        "apps/ready-for-agent/src/interactive-resume-v2-contract.test.ts",
      )
    expect(cases).toBe(EXPECTED_OPENCODE_CLI_CONTRACT_CASES)
  })

  it("documents the baseline and does not leave contract CI as a follow-up", () => {
    const doc = read("packages/opencode/CLI-CONTRACT.md")
    expect(doc).toContain("2.0.32")
    expect(doc).toContain("OPENCODE_CONTRACT_MODE=latest")
    expect(doc).not.toContain("CI required-check wiring is BER-36")
    expect(read("docs/e2e-fixture.md")).toContain("`opencode-cli-contract`")
  })
})

describe("workflow files stay free of contract skips", () => {
  it("does not path-filter the required workflows", () => {
    const names = readdirSync(join(workspaceRoot, ".github/workflows"))
    expect(names).toContain("opencode-cli-contract-drift.yml")
    expect(names).toContain("pr.yml")
    expect(names).toContain("ci-cd.yml")
  })
})
