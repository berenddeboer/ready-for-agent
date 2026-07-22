import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const indexSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/index.tsx"), "utf8")

describe("Repository settings Include all Issue Authors", () => {
  test("exposes Include all Issue Authors in settings and saves local state", () => {
    const source = indexSource()
    expect(source).toContain("Include all Issue Authors")
    expect(source).toContain(
      "const [includeAllIssueAuthors, setIncludeAllIssueAuthors] = useState(",
    )
    expect(source).toContain(
      "setIncludeAllIssueAuthors(repository.includeAllIssueAuthors)",
    )
    expect(source).toContain("checked={includeAllIssueAuthors}")
    expect(source).toContain("setIncludeAllIssueAuthors(event.target.checked)")
    expect(source).toMatch(
      /updateSettings\.mutate\(\{[\s\S]*includeAllIssueAuthors,[\s\S]*\}\)/,
    )
    expect(source).not.toContain(
      "includeAllIssueAuthors: repository.includeAllIssueAuthors",
    )
    expect(source).toContain("Relevant Issues from every author after Refresh")
    expect(source).toContain(
      '{repository.includeAllIssueAuthors ? "Enabled" : "Disabled"}',
    )
  })

  test("issue list queries and shows Issue Author as secondary text", () => {
    const source = indexSource()
    expect(source).toContain("issueAuthor: true")
    expect(source).toContain("issueAuthor: string | null")
    expect(source).toContain(
      'issue.issueAuthor !== null && issue.issueAuthor !== ""',
    )
    expect(source).toContain("{issue.issueAuthor}")
    expect(source).not.toContain("Show all authors")
    expect(source).not.toContain("mine only")
    expect(source).not.toContain("Mine only")
  })
})
