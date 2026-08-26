/**
 * Operator-facing Azure DevOps docs: README Features / Requirements / add,
 * Boards tags, ambient PAT, empty default branch, Merge Policy Always for
 * no-CI, and harness-owned Boards close-out after merge.
 */

import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "bun:test"

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const workspaceRoot = resolve(appRoot, "../..")
const publicReadmePath = join(workspaceRoot, "README.md")
const monorepoAddReadmePath = join(appRoot, "README.md")
const usageSpecPath = join(appRoot, "ready-for-agent.usage.kdl")
const cliPath = join(appRoot, "src/cli.ts")
const azureOperatorDocPath = join(workspaceRoot, "docs/azure-devops.md")
const scopesTicketUrl =
  "https://github.com/berenddeboer/ready-for-agent/issues/1213"

const markdownSection = (source: string, heading: string): string => {
  const start = source.indexOf(`${heading}\n`)
  if (start < 0) return ""
  const rest = source.slice(start + heading.length + 1)
  const next = rest.search(/\n## |\n# /)
  return (next < 0 ? rest : rest.slice(0, next)).trim()
}

const addCommandHelp = (usageSpec: string): string => {
  const match = usageSpec.match(/cmd "add" help="([^"]+)"/)
  return match?.[1] ?? ""
}

describe("Azure DevOps operator documentation", () => {
  test("README Features, Requirements, and add path name Azure DevOps alongside GitHub and GitLab", () => {
    const readme = readFileSync(publicReadmePath, "utf8")
    const features = markdownSection(readme, "## Features")
    const requirements = markdownSection(readme, "## Requirements")
    const quickStart = markdownSection(readme, "## Quick start")
    const addReference = markdownSection(readme, "## `ready-for-agent add`")

    expect(features).toContain("Azure DevOps")
    expect(features).toContain("GitHub")
    expect(features).toContain("GitLab")

    expect(requirements).toContain("Azure DevOps")
    expect(requirements).toContain("GitHub")
    expect(requirements).toContain("GitLab")
    expect(requirements).toContain("AZURE_DEVOPS_EXT_PAT")

    expect(quickStart).toContain("Azure DevOps")
    expect(quickStart).toContain("ready-for-agent add")
    expect(addReference).toContain("Azure DevOps")

    const monorepoAdd = readFileSync(monorepoAddReadmePath, "utf8")
    expect(monorepoAdd).toContain("Azure DevOps")
    expect(monorepoAdd).not.toMatch(
      /git repository with a GitHub or GitLab remote/,
    )
  })

  test("add help names Azure DevOps as a supported Forge", () => {
    const usageSpec = readFileSync(usageSpecPath, "utf8")
    const cli = readFileSync(cliPath, "utf8")
    const help = addCommandHelp(usageSpec)

    expect(help).toContain("Azure DevOps")
    expect(help).toContain("GitHub")
    expect(help).toContain("GitLab")
    expect(cli).toContain(help)
  })

  test("operator docs describe Boards tags, the ambient PAT, empty default branch, and Always for no-CI", () => {
    expect(existsSync(azureOperatorDocPath)).toBe(true)
    const azureDoc = readFileSync(azureOperatorDocPath, "utf8")
    const readme = readFileSync(publicReadmePath, "utf8")

    expect(azureDoc).toMatch(/Boards tag/)
    expect(azureDoc).toContain("`ready-for-agent`")
    expect(azureDoc).not.toMatch(/Ready[- ]labeled Issues are Azure labels/)
    expect(azureDoc).toContain("AZURE_DEVOPS_EXT_PAT")
    expect(azureDoc).toContain(scopesTicketUrl)
    expect(azureDoc).toMatch(/no default branch/)
    expect(azureDoc).toMatch(/Merge Policy/)
    expect(azureDoc).toMatch(/\boff\b/)
    expect(azureDoc).toMatch(/\bAlways\b/)
    expect(azureDoc).toMatch(/no-CI|no CI|without CI|absence of CI/)

    expect(readme).toContain("docs/azure-devops.md")
    expect(readme).toMatch(/Boards tag/)
  })

  test("operator docs describe harness-owned Boards close-out after merge", () => {
    const azureDoc = readFileSync(azureOperatorDocPath, "utf8")
    const readme = readFileSync(publicReadmePath, "utf8")
    expect(azureDoc).toMatch(/close-out/)
    expect(azureDoc).toMatch(/still open/)
    expect(azureDoc).toMatch(/Completed-category|Done on Basic|Closed on Agile/)
    expect(azureDoc).not.toMatch(/not yet at parity|still being finished/)
    expect(azureDoc).not.toMatch(
      /work item close-out with a completion summary are all implemented/,
    )
    expect(readme).not.toMatch(/Boards close-out is not yet at parity/)
  })
})
