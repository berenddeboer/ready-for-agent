import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const indexSource = () =>
  readFileSync(join(import.meta.dir, "../src/home-page-content.tsx"), "utf8")

describe("Repository settings Linear discovery", () => {
  test("offers Linear only for GitHub-hosted Repositories after onboarding", () => {
    const source = indexSource()
    expect(source).toContain('{forge === "github" && (')
    expect(source).toContain("Issue Tracker")
    expect(source).toContain('<option value="linear">Linear</option>')
    expect(source).toContain(
      "Adding this Repository used GitHub automatically. Linear",
    )
    expect(source).toContain("Open Issues still")
    expect(source).toContain("ready-for-agent label")
    expect(source).toContain(
      'issueTracker: forge === "github" ? issueTracker : forge',
    )
    expect(source).not.toContain("without per-Issue")
  })

  test("configures a personal Linear API key through Keymaxxer independently of GitHub", () => {
    const source = indexSource()
    expect(source).toContain('queryKey: ["linearCredential"]')
    expect(source).toContain("addLinearApiKey")
    expect(source).toContain("Create Linear API key")
    expect(source).toContain("Store in Keymaxxer")
    expect(source).toContain("Linear API key required")
    expect(source).toContain("It is independent of this Repository's GitHub")
    expect(source).toContain("linearProjects.isError")
    expect(source).toContain(
      "Linear request failed. Check the API key and try again.",
    )
    expect(source).toContain("setLinearTokenCreated(false)")
  })

  test("shows mapped-project children whose parent is not in the local list", () => {
    const source = indexSource()
    expect(source).toContain("localIssueNativeIds")
    expect(source).toContain("localIssueNativeIds.has(issue.parent.nativeId)")
  })

  test("maps one Linear project and suggested team In Progress/Done statuses", () => {
    const source = indexSource()
    expect(source).toContain("Linear project")
    expect(source).toContain('queryKey: ["linearProjects"]')
    expect(source).toContain(
      'queryKey: ["linearProjectWorkflow", linearProjectId]',
    )
    expect(source).toContain("suggestedInProgressStateId")
    expect(source).toContain("suggestedDoneStateId")
    expect(source).toContain("In Progress")
    expect(source).toContain("Done")
    expect(source).toContain("linearWorkflowStatuses")
  })

  test("starts Linear leaf Issues from Implement and Queue while hiding Implement All", () => {
    const source = indexSource()
    expect(source).toContain("const canImplementNow = canImplement")
    expect(source).toContain("const canQueueNow = canQueue")
    expect(source).not.toContain("canStartLinearExecution")
    expect(source).toContain(
      "offersParentImplementAll(repository.issueTracker) &&",
    )
  })
})
