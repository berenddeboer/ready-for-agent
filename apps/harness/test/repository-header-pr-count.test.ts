import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const homeSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/index.tsx"), "utf8")

const refreshSource = () =>
  readFileSync(
    join(import.meta.dir, "../src/refresh-work-items-live.ts"),
    "utf8",
  )

describe("repository header pull request count", () => {
  test("repositories query requests total pullRequestCount", () => {
    const source = homeSource()
    expect(source).toContain("pullRequestCount: true")
    expect(source).toContain("pullRequestCount: number")
  })

  test("header renders the count immediately after the repository name", () => {
    const source = homeSource()
    const titleIndex = source.indexOf("title={pullRequestCountLabel}")
    expect(titleIndex).toBeGreaterThan(-1)
    // Count sits in the same h2 as the repository name link.
    const headerStart = source.lastIndexOf("<h2", titleIndex)
    const headerEnd = source.indexOf("</h2>", titleIndex)
    expect(headerStart).toBeGreaterThan(-1)
    expect(headerEnd).toBeGreaterThan(titleIndex)
    const header = source.slice(headerStart, headerEnd)
    const nameInHeader = header.indexOf("{repositoryLabel}")
    const countInHeader = header.indexOf("{repository.pullRequestCount}")
    expect(nameInHeader).toBeGreaterThan(-1)
    expect(countInHeader).toBeGreaterThan(nameInHeader)
    expect(header).toContain('className="sr-only"')
    expect(header).toContain("{pullRequestCountLabel}")
    expect(header).toContain('aria-hidden="true"')
    expect(header).toContain("shrink-0")
    expect(header).toContain("tabular-nums")
  })

  test("zero PRs use plural accessible label without special-casing away the digit", () => {
    const source = homeSource()
    expect(source).toContain('? "1 pull request"')
    expect(source).toContain("pull requests`")
    expect(source).toContain("repository.pullRequestCount === 1")
  })

  test("work-item live refresh keeps repository PR counts current", () => {
    const source = refreshSource()
    expect(source).toContain("pullRequestCount")
    expect(source).toContain('const repositoriesQueryKey = ["repositories"]')
  })
})
