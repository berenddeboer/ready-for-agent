import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const homeSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/index.tsx"), "utf8")

const sliceBetweenMarkers = (
  source: string,
  startMarker: string,
  endMarker: string,
): string => {
  const start = source.indexOf(startMarker)
  if (start < 0) {
    throw new Error(`Start marker not found: ${startMarker}`)
  }
  const end = source.indexOf(endMarker, start)
  if (end < 0) {
    throw new Error(`End marker not found after ${startMarker}: ${endMarker}`)
  }
  return source.slice(start, end)
}

const repositoryCardsSource = () =>
  sliceBetweenMarkers(
    homeSource(),
    "function RepositoryCards()",
    "function AddRepositoryGuidance(",
  )

const addRepositoryGuidanceSource = () =>
  sliceBetweenMarkers(
    homeSource(),
    "function AddRepositoryGuidance(",
    "function RepositoryCard(",
  )

describe("blank-slate add repository command", () => {
  test("loads suggested CLI from GraphQL addRepositoryCommand query", () => {
    const source = homeSource()
    expect(source).toContain("addRepositoryCommand")
    expect(source).toContain("addRepositoryCommandQuery")
    expect(source).toContain("useSuspenseQuery(\n    addRepositoryCommandQuery")
    expect(source).not.toContain(
      "ready-for-agent add /path/to/local/repo\n          </code>",
    )
  })

  test("shows add-repository guidance in the empty state via shared section", () => {
    const cards = repositoryCardsSource()
    const emptyStart = cards.indexOf("if (repositories.length === 0)")
    const emptyReturn = cards.indexOf("return (", emptyStart)
    const populatedReturn = cards.indexOf("return (", emptyReturn + 1)
    const emptyBranch = cards.slice(emptyStart, populatedReturn)
    expect(emptyBranch).toContain("<AddRepositoryGuidance")
    expect(emptyBranch).toContain("command={addRepositoryCommand}")
    expect(emptyBranch).toContain('heading="No repositories configured"')
  })

  test("repeats add-repository guidance below configured repositories", () => {
    const cards = repositoryCardsSource()
    const emptyStart = cards.indexOf("if (repositories.length === 0)")
    const emptyReturn = cards.indexOf("return (", emptyStart)
    const populatedReturn = cards.indexOf("return (", emptyReturn + 1)
    const populated = cards.slice(populatedReturn)
    expect(populated).toContain('aria-label="Configured repositories"')
    expect(populated).toContain("<AddRepositoryGuidance")
    expect(populated).toContain("command={addRepositoryCommand}")
    // Populated footer reuses the command; empty-state heading only.
    expect(populated).not.toContain('heading="No repositories configured"')
  })

  test("shared guidance renders the dynamic command without hard-coding it", () => {
    const guidance = addRepositoryGuidanceSource()
    expect(guidance.length).toBeGreaterThan(0)
    expect(guidance).toContain("command")
    expect(guidance).toContain("{command}")
    expect(guidance).toContain(
      "Add a local Git repository with the operator binary:",
    )
    expect(guidance).toContain('aria-label="Add a repository"')
    expect(guidance).toContain("max-w-full overflow-x-auto")
    expect(guidance).not.toContain("ready-for-agent add /path/to/local/repo")
  })
})
