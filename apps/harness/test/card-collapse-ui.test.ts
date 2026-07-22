import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const homeSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/index.tsx"), "utf8")

const toggleSource = () =>
  readFileSync(join(import.meta.dir, "../src/card-collapse-toggle.tsx"), "utf8")

describe("collapsible jobs and repository cards", () => {
  test("jobs section has expand/collapse control and hides body when collapsed", () => {
    const source = homeSource()
    expect(source).toContain('from "../card-collapse.js"')
    expect(source).toContain('from "../card-collapse-toggle.js"')
    expect(source).toContain("jobsCardCollapseId()")
    expect(source).toContain("useCardCollapsed(jobsCardCollapseId())")
    expect(source).toContain('label="Jobs"')
    expect(source).toContain("jobs-card-body")
    expect(source).toContain("!jobsCollapsed &&")
    expect(source).toContain("toggleJobsCollapsed")
  })

  test("repository cards collapse body while keeping header controls", () => {
    const source = homeSource()
    expect(source).toContain("repositoryCardCollapseId(repository.id)")
    expect(source).toContain("repository-card-body-")
    expect(source).toContain("!repositoryCollapsed &&")
    expect(source).toContain("toggleRepositoryCollapsed")
    expect(source).toContain("label={repositoryLabel}")
    const collapseToggleIndex = source.indexOf(
      "collapsed={repositoryCollapsed}",
    )
    const actionsMenuIndex = source.indexOf("data-repo-menu={repository.id}")
    const bodyStart = source.indexOf("!repositoryCollapsed &&")
    expect(collapseToggleIndex).toBeGreaterThan(-1)
    expect(actionsMenuIndex).toBeGreaterThan(collapseToggleIndex)
    expect(bodyStart).toBeGreaterThan(actionsMenuIndex)
  })

  test("collapse toggle is a keyboard-focusable button with aria-expanded", () => {
    const source = toggleSource()
    expect(source).toContain('type="button"')
    expect(source).toContain("aria-expanded={!collapsed}")
    expect(source).toContain("aria-controls={controlsId}")
    expect(source).toContain("Expand ")
    expect(source).toContain("Collapse ")
    expect(source).toContain("focus-visible:outline-2")
  })
})
