import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const workspaceRoot = join(import.meta.dir, "../../..")

const publishedDocUrl =
  "https://github.com/berenddeboer/ready-for-agent/blob/main/docs/forge-token-scopes.md"

const readWorkspace = (relativePath: string) =>
  readFileSync(join(workspaceRoot, relativePath), "utf8")

describe("published Forge token scopes doc", () => {
  test("lists minimum scopes per Forge for every required lifecycle step", () => {
    const doc = readWorkspace("docs/forge-token-scopes.md")
    for (const forge of ["GitHub", "GitLab", "Azure DevOps"]) {
      expect(doc).toContain(forge)
    }
    for (const step of [
      "poll Ready Issues",
      "push",
      "Create PR",
      "Mark PR Ready for Review",
      "Watch",
      "Merge PR",
      "close-out",
    ]) {
      expect(doc).toContain(step)
    }
    expect(doc).toContain("Contents")
    expect(doc).toContain("Issues")
    expect(doc).toContain("Pull requests")
    expect(doc).toContain("Actions")
    expect(doc).toContain("Workflows")
    expect(doc).toContain("`api`")
    expect(doc).toContain("`write_repository`")
    expect(doc).toContain("Code: Read & write")
    expect(doc).toContain("Work Items: Read & write")
    expect(doc).toContain("Build: Read")
    expect(doc).toContain("Policy: Read")
  })

  test("calls out that Azure complete/merge needs more than git and Create PR", () => {
    const doc = readWorkspace("docs/forge-token-scopes.md")
    expect(doc).toContain("Merge PR needs more than git + Create PR")
    expect(doc).toContain("transitionWorkItems")
    expect(doc).toContain("Work Items (Read & write)")
    expect(doc).toContain(
      "Do not mint **Code (Read, write, & manage)** for Merge PR",
    )
  })

  test("README and add-repository docs link to the published list", () => {
    const readme = readWorkspace("README.md")
    expect(readme).toContain("docs/forge-token-scopes.md")
    const addRepo = readWorkspace("apps/ready-for-agent/README.md")
    expect(addRepo).toContain("docs/forge-token-scopes.md")
  })

  test("repo-card token banners point at the same published list", () => {
    const home = readWorkspace("apps/harness/src/home-page-content.tsx")
    expect(home).toContain(publishedDocUrl)
    expect(home).toContain("GitHub token required")
    expect(home).toContain("GitLab authentication required")
  })
})
