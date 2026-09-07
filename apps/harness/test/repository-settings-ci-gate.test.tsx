import { readFileSync } from "node:fs"
import { join } from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import {
  CI_GATE_DEFINITIONS_LOADING_LABEL,
  CI_GATE_DISABLED_HINT,
  RepositorySettingsCiGateSection,
  ciGateCatalogViewFromQuery,
} from "../src/repository-settings-ci-gate.js"
import { describe, expect, test } from "bun:test"

const indexSource = () =>
  readFileSync(join(import.meta.dir, "../src/home-page-content.tsx"), "utf8")

const repositoriesQuerySource = () =>
  readFileSync(join(import.meta.dir, "../src/repositories-query.ts"), "utf8")

const sliceBetween = (source: string, start: string, end: string): string => {
  const from = source.indexOf(start)
  if (from < 0) {
    throw new Error(`Start marker not found: ${start}`)
  }
  const to = source.indexOf(end, from)
  if (to < 0) {
    throw new Error(`End marker not found after ${start}: ${end}`)
  }
  return source.slice(from, to)
}

const dialogSectionHeadingIds = (dialog: string): string[] => {
  const matches = dialog.matchAll(
    /id=\{`repo-sec-([a-z-]+)-\$\{repository\.id\}`\}/g,
  )
  return [...matches].map((match) => match[1] ?? "")
}

const ciDefinition = {
  identity: "ci.yml",
  displayLabel: "Ready for Agent CI",
  diagnosticMetadata: "GitHub workflow",
}

const lintDefinition = {
  identity: "lint.yml",
  displayLabel: "Lint",
  diagnosticMetadata: null,
}

const baseStatus = {
  statusLabel: "Open",
  diagnostic: "Repository CI Gate is open.",
  activeIncidentSummary: null,
  latestResolvedIncidentSummary: null,
}

const renderSection = (
  overrides: Partial<
    Parameters<typeof RepositorySettingsCiGateSection>[0]
  > = {},
) =>
  renderToStaticMarkup(
    <RepositorySettingsCiGateSection
      repositoryId="repo-1"
      catalog={{ kind: "pending" }}
      selectedIdentities={[]}
      onSelectedIdentitiesChange={() => {}}
      status={baseStatus}
      {...overrides}
    />,
  )

describe("Repository settings CI Gate Definitions", () => {
  test("CI Gate is the last settings section, directly below Models", () => {
    const dialog = sliceBetween(
      indexSource(),
      "ref={settingsDialogRef}",
      "</dialog>",
    )
    expect(dialogSectionHeadingIds(dialog)).toEqual([
      "identity",
      "options",
      "agent",
      "models",
    ])
    const modelsHeading = dialog.indexOf("repo-sec-models-")
    const ciGateSection = dialog.indexOf("<RepositorySettingsCiGateSection")
    const footer = dialog.indexOf("ui.dialogFooter")
    expect(modelsHeading).toBeGreaterThan(-1)
    expect(ciGateSection).toBeGreaterThan(modelsHeading)
    expect(ciGateSection).toBeGreaterThan(-1)
    expect(footer).toBeGreaterThan(ciGateSection)
  })

  test("catalog discovery uses a local pending query, not the Repos Suspense boundary", () => {
    const source = indexSource()
    expect(source).toContain("createHarnessGraphqlClient({ batch: false })")
    expect(source).toMatch(
      /ciGateCatalogQuery[\s\S]*graphqlUnbatched\.query\(\{[\s\S]*ciGateCatalog:/,
    )
    expect(source).toContain(
      "useQuery({\n    ...ciGateCatalogQuery(repository.id)",
    )
    expect(source).not.toContain(
      "useSuspenseQuery({\n    ...ciGateCatalogQuery",
    )
    expect(source).toContain("ciGateCatalog.isPending")
    expect(source).not.toContain("ciGateCatalog.isFetching")
    const dialog = sliceBetween(source, "ref={settingsDialogRef}", "</dialog>")
    expect(dialog).not.toContain("<Suspense")
  })

  test("loads the live catalog and covers selection states in settings", () => {
    const source = indexSource()
    expect(source).toContain("RepositorySettingsCiGateSection")
    expect(source).toContain("selectedCiGateDefinitionIdentities")
    expect(source).toContain("ciGateCatalogViewFromQuery")
    expect(source).toMatch(
      /updateSettings\.mutate\(\{[\s\S]*selectedCiGateDefinitionIdentities: \[\.\.\.selectedCiGateIdentities\]/,
    )
    expect(source).toContain("setSelectedCiGateIdentities")
    expect(source).toContain("repository.selectedCiGateDefinitions.map(")
  })

  test("shows persisted selections and empty default on the Repository card", () => {
    const source = indexSource()
    expect(source).toContain("<dt>CI Gate</dt>")
    expect(source).toContain("ciGateStatusLabel(repository.ciGate.status)")
    expect(source).toContain("repository.ciGate.activeIncident")
    expect(source).toContain("repository.ciGate.latestResolvedIncident")
    expect(source).toContain("View run")
  })

  test("repositories query asks for selected CI Gate Definitions and gate projection", () => {
    const source = repositoriesQuerySource()
    expect(source).toContain("selectedCiGateDefinitions")
    expect(source).toContain("displayLabel: true")
    expect(source).toContain("diagnosticMetadata: true")
    expect(source).toContain("ciGate:")
    expect(source).toContain("activeIncident:")
    expect(source).toContain("latestResolvedIncident:")
    expect(source).toContain("htmlUrl: true")
  })
})

describe("Repository settings CI Gate catalog presentation", () => {
  test("pending discovery is a local loading indication, not an empty catalog", () => {
    const html = renderSection({
      catalog: { kind: "pending" },
      selectedIdentities: [],
    })
    expect(html).toContain(CI_GATE_DEFINITIONS_LOADING_LABEL)
    expect(html).toContain("CI Gate")
    expect(html).not.toContain('name="selectedCiGateDefinitionIdentities"')
    expect(html).not.toContain("Ready for Agent CI")
    expect(html).toContain(CI_GATE_DISABLED_HINT)
  })

  test("pending discovery keeps saved selections instead of clearing them", () => {
    const html = renderSection({
      catalog: { kind: "pending" },
      selectedIdentities: [ciDefinition.identity],
    })
    expect(html).toContain(CI_GATE_DEFINITIONS_LOADING_LABEL)
    expect(html).toContain(
      "Selected definitions watch default-branch CI. Empty selection disables the Repository CI Gate.",
    )
    expect(html).not.toContain(CI_GATE_DISABLED_HINT)
  })

  test("resolved names replace the local loading indication", () => {
    const html = renderSection({
      catalog: {
        kind: "loaded",
        definitions: [ciDefinition, lintDefinition],
        unavailable: [],
      },
    })
    expect(html).not.toContain(CI_GATE_DEFINITIONS_LOADING_LABEL)
    expect(html).toContain("Ready for Agent CI")
    expect(html).toContain("Lint")
    expect(html).toContain('value="ci.yml"')
    expect(html).toContain('value="lint.yml"')
    expect(html).toContain("GitHub workflow")
  })

  test("fast catalog results render names without a loading hold", () => {
    const html = renderSection({
      catalog: {
        kind: "loaded",
        definitions: [ciDefinition],
        unavailable: [],
      },
    })
    expect(html).toContain("Ready for Agent CI")
    expect(html).not.toContain(CI_GATE_DEFINITIONS_LOADING_LABEL)
  })

  test("discovery failure keeps persisted selections and the error", () => {
    const html = renderSection({
      catalog: {
        kind: "error",
        message: "The live CI Gate catalog could not be loaded",
        persisted: [ciDefinition],
      },
      selectedIdentities: [ciDefinition.identity],
    })
    expect(html).toContain("The live CI Gate catalog could not be loaded")
    expect(html).toContain('role="alert"')
    expect(html).toContain("Ready for Agent CI")
    expect(html).toContain('value="ci.yml"')
    expect(html).toContain("checked")
    expect(html).not.toContain(CI_GATE_DEFINITIONS_LOADING_LABEL)
  })

  test("unavailable saved selections stay checked with Forge-neutral wording", () => {
    const html = renderSection({
      catalog: {
        kind: "loaded",
        definitions: [lintDefinition],
        unavailable: [ciDefinition],
      },
      selectedIdentities: [ciDefinition.identity],
    })
    expect(html).toContain("Ready for Agent CI (unavailable)")
    expect(html).toContain("Lint")
    expect(html).not.toContain("workflow file")
    expect(html).not.toContain("GitHub Actions")
  })

  test("status and incidents stay visible while the catalog is pending", () => {
    const html = renderSection({
      catalog: { kind: "pending" },
      status: {
        statusLabel: "Closed",
        diagnostic: "Repository CI Gate is closed: CI failed.",
        activeIncidentSummary: "CI Gate closed: CI failed.",
        latestResolvedIncidentSummary:
          "CI Gate recovered: newer success on CI.",
      },
    })
    expect(html).toContain("Current status: Closed")
    expect(html).toContain("Repository CI Gate is closed: CI failed.")
    expect(html).toContain("Active incident: CI Gate closed: CI failed.")
    expect(html).toContain(
      "Last resolved: CI Gate recovered: newer success on CI.",
    )
  })

  test("ciGateCatalogViewFromQuery keeps saved selections out of the pending view", () => {
    expect(
      ciGateCatalogViewFromQuery({
        pending: true,
        catalog: {
          error: null,
          definitions: [ciDefinition],
        },
        selectedIdentities: [ciDefinition.identity],
        savedDefinitions: [ciDefinition],
      }),
    ).toEqual({ kind: "pending" })
    expect(
      ciGateCatalogViewFromQuery({
        pending: false,
        catalog: {
          error: "The live CI Gate catalog could not be loaded",
          definitions: [],
        },
        selectedIdentities: [ciDefinition.identity],
        savedDefinitions: [ciDefinition],
      }),
    ).toEqual({
      kind: "error",
      message: "The live CI Gate catalog could not be loaded",
      persisted: [ciDefinition],
    })
    expect(
      ciGateCatalogViewFromQuery({
        pending: false,
        catalog: { error: null, definitions: [lintDefinition] },
        selectedIdentities: [ciDefinition.identity],
        savedDefinitions: [ciDefinition],
      }),
    ).toEqual({
      kind: "loaded",
      definitions: [lintDefinition],
      unavailable: [ciDefinition],
    })
  })
})
