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
    "export function RepositoryCards()",
    "function AddRepositoryGuidance(",
  )

const addRepositoryGuidanceSource = () =>
  sliceBetweenMarkers(
    homeSource(),
    "function AddRepositoryGuidance(",
    "function RepositoryCard(",
  )

const emptyBlankSlateSource = () =>
  sliceBetweenMarkers(
    homeSource(),
    "function EmptyRepositoriesBlankSlate()",
    "export function RepositoryCards()",
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

  test("home zero-repo gate reuses EmptyRepositoriesBlankSlate", () => {
    const home = homeSource()
    const homeContent = home.slice(
      home.indexOf("function HomeContent()"),
      home.indexOf("function EmptyRepositoriesBlankSlate()"),
    )
    expect(homeContent).toContain("(repositories ?? []).length === 0")
    expect(homeContent).toContain("<EmptyRepositoriesBlankSlate />")
    expect(homeContent).toContain("<KanbanBoard />")
  })

  test("EmptyRepositoriesBlankSlate wraps shared guidance with empty heading", () => {
    const blank = emptyBlankSlateSource()
    expect(blank).toContain("<AddRepositoryGuidance")
    expect(blank).toContain("command={addRepositoryCommand}")
    expect(blank).toContain('heading="No repositories configured"')
  })

  test("blank slate uses Interchange §4.7 Setup kicker, dashed panel, primary plate", () => {
    const guidance = addRepositoryGuidanceSource()
    expect(guidance).toContain("className={ui.blankSlate}")
    expect(guidance).toContain("ui.kickerTag")
    expect(guidance).toContain("Setup")
    expect(guidance).toContain("ui.blankSlateTitle")
    expect(guidance).toContain("ui.blankSlateInput")
    expect(guidance).toContain("ui.plateMini")
    expect(guidance).toContain("ui.platePrimary")
    expect(guidance).toContain("ui.blankSlateFieldset")
    expect(guidance).toContain("Confirm forge identity")
    expect(guidance).toContain("ui.guidanceCode")
    expect(guidance).toContain('tone="alarm"')
    expect(guidance).toContain('role="alert"')
    // Ledger serif / oxblood CTA language is gone from this surface.
    expect(guidance).not.toContain("font-serif")
    expect(guidance).not.toContain("bg-oxblood")
  })

  test("shows add-repository guidance in the empty state via shared blank slate", () => {
    const cards = repositoryCardsSource()
    const emptyStart = cards.indexOf("if (repositories.length === 0)")
    const emptyReturn = cards.indexOf("return (", emptyStart)
    const populatedReturn = cards.indexOf("return (", emptyReturn + 1)
    const emptyBranch = cards.slice(emptyStart, populatedReturn)
    expect(emptyBranch).toContain("<EmptyRepositoriesBlankSlate />")
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
    expect(guidance).toContain(
      'cx(ui.guidanceCode, "max-w-full", "overflow-x-auto")',
    )
    expect(guidance).not.toContain("ready-for-agent add /path/to/local/repo")
  })

  test("primary UI is path entry and optional host Browse before CLI guidance", () => {
    const guidance = addRepositoryGuidanceSource()
    expect(guidance).toContain("addLocalRepository")
    expect(guidance).toContain("directoryPickerAvailable")
    // Non-suspense so Browse availability cannot re-suspend the whole page.
    expect(guidance).toContain("useQuery(\n    directoryPickerAvailableQuery")
    expect(guidance).not.toContain(
      "useSuspenseQuery(\n    directoryPickerAvailableQuery",
    )
    expect(guidance).toContain("pickLocalDirectory")
    // Host folder dialog is long-lived; must not share the batched client.
    expect(guidance).toContain("graphqlUnbatched.mutation")
    expect(guidance).toContain("Browse…")
    expect(guidance).toContain("ui.blankSlateDivider")
    expect(guidance).toContain(">or</")
    expect(guidance).toContain('id="add-repository-path"')
    expect(guidance).toContain('placeholder="/path/to/local/repo"')
    expect(guidance).toContain(
      "Could not open the folder dialog. Enter a path instead.",
    )
    // pick→add handoff keeps controls disabled (no busy=false gap).
    expect(guidance).toContain("pickToAddBridging")
    expect(guidance).toContain("setPickToAddBridging(true)")

    const separatorAt = guidance.indexOf("ui.blankSlateDivider")
    const cliCopyAt = guidance.indexOf(
      "Add a local Git repository with the operator binary:",
    )
    const pathFieldAt = guidance.indexOf('id="add-repository-path"')
    expect(pathFieldAt).toBeGreaterThan(-1)
    expect(separatorAt).toBeGreaterThan(pathFieldAt)
    expect(cliCopyAt).toBeGreaterThan(separatorAt)
    // Browser File System Access API must not be the localPath source.
    expect(guidance).not.toContain("showDirectoryPicker")
    expect(guidance).not.toContain("webkitdirectory")
  })
})
