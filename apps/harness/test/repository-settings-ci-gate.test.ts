import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const indexSource = () =>
  readFileSync(join(import.meta.dir, "../src/home-page-content.tsx"), "utf8")

const repositoriesQuerySource = () =>
  readFileSync(join(import.meta.dir, "../src/repositories-query.ts"), "utf8")

describe("Repository settings CI Gate Definitions", () => {
  test("loads the live catalog and covers selection states in settings", () => {
    const source = indexSource()
    expect(source).toContain("CI Gate")
    expect(source).toContain("Loading CI Gate Definitions…")
    expect(source).toContain("repo-sec-ci-gate-")
    expect(source).toContain("ciGateCatalog")
    expect(source).toContain("selectedCiGateDefinitionIdentities")
    expect(source).toContain("(unavailable)")
    expect(source).toContain(
      "No CI Gate Definitions selected — Repository CI Gate is disabled.",
    )
    expect(source).toContain('role="alert"')
    expect(source).toMatch(
      /updateSettings\.mutate\(\{[\s\S]*selectedCiGateDefinitionIdentities: \[\.\.\.selectedCiGateIdentities\]/,
    )
    expect(source).toContain("setSelectedCiGateIdentities")
    expect(source).toContain("repository.selectedCiGateDefinitions.map(")
  })

  test("shows persisted selections and empty default on the Repository card", () => {
    const source = indexSource()
    expect(source).toContain("<dt>CI Gate</dt>")
    expect(source).toContain(
      "repository.selectedCiGateDefinitions.length === 0",
    )
    expect(source).toContain('? "Disabled"')
    expect(source).toContain("definition.displayLabel")
  })

  test("repositories query asks for selected CI Gate Definitions", () => {
    const source = repositoriesQuerySource()
    expect(source).toContain("selectedCiGateDefinitions")
    expect(source).toContain("displayLabel: true")
    expect(source).toContain("diagnosticMetadata: true")
  })
})
