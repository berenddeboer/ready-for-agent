import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const indexSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/index.tsx"), "utf8")

describe("Repository settings Agent Backend override", () => {
  test("offers harness-default option and places backend control above models", () => {
    const source = indexSource()
    expect(source).toContain("HARNESS_DEFAULT_BACKEND_VALUE")
    expect(source).toContain("Harness default ({harnessDefaultBackendLabel})")
    expect(source).toContain('name="selectedAgentBackend"')
    expect(source).toContain("selectedAgentBackend: true")
    expect(source).toContain("effectiveAgentBackend: true")
    expect(source).toContain("blockingUnfinishedWorkItemCount: true")
    expect(source).toContain("selectedAgentBackend: string | null")
    expect(source).toContain("applyAgentBackendSelection")
    expect(source).toContain("previewAgentBackend")
    expect(source).toContain("harnessModelPrefs")

    // Prefer the settings-dialog control (name=), not the card summary.
    const backendSelectIndex = source.indexOf('name="selectedAgentBackend"')
    const buildModelIndex = source.indexOf("Build model")
    // Backend select must appear above the first Build model field in the dialog.
    expect(backendSelectIndex).toBeGreaterThan(-1)
    expect(buildModelIndex).toBeGreaterThan(backendSelectIndex)
  })

  test("disables backend change with scoped unfinished reason and saves override", () => {
    const source = indexSource()
    expect(source).toContain("backendChangeBlocked")
    expect(source).toContain("blockingUnfinishedWorkItemCount")
    expect(source).toContain("on this Repository")
    expect(source).toMatch(
      /updateSettings\.mutate\(\{[\s\S]*selectedAgentBackend,[\s\S]*\}\)/,
    )
    expect(source).toContain("selectedAgentBackend: string | null")
  })

  test("work item detail continues to show captured backend provenance", () => {
    const source = indexSource()
    expect(source).toContain("agentBackend: { id: true, label: true }")
    // Presentation lives on kanban tickets and completed rows (not home Jobs).
    const board = readFileSync(
      join(import.meta.dir, "../src/kanban-board.tsx"),
      "utf8",
    )
    const completedRow = readFileSync(
      join(import.meta.dir, "../src/completed-work-item-row.tsx"),
      "utf8",
    )
    expect(board).toContain("{workItem.agentBackend.label}")
    expect(completedRow).toContain("{workItem.agentBackend.label}")
  })

  test("override preview requests provider and shows Ready status wording", () => {
    // Issue #819: Repository Settings mirrors harness provider identity on preview.
    const source = indexSource()
    expect(source).toContain("provider: { id: true, label: true }")
    expect(source).toContain("formatAgentBackendStatusLabel")
    expect(source).toContain("previewProvider")
    expect(source).toContain("setPreviewProvider(null)")
    expect(source).toContain("usesPreviewCatalog && !previewPending")
  })

  test("override preview requests discovery warnings and keeps a catalog-only select (issues #828, #838)", () => {
    // Issue #820 warnings remain; #838 makes every backend catalog-strict.
    const source = indexSource()
    expect(source).toContain("warnings: true")
    expect(source).toContain("previewWarnings")
    expect(source).toContain("setPreviewWarnings")
    expect(source).toContain("configurationMode: true")
    expect(source).toContain("claudeBedrockStrict")
    expect(source).toContain("blocksAgentModelSave")
    expect(source).toContain("buildModelBlockReason")
    expect(source).toContain("No Bedrock profiles available")
    expect(source).toContain("discovered Bedrock inference profile")
    // Disabled button and form onSubmit share one gate (Enter cannot bypass).
    expect(source).toContain("repositorySettingsSaveBlocked")
    expect(source).toContain("if (repositorySettingsSaveBlocked)")
    expect(source).toContain("disabled={repositorySettingsSaveBlocked}")
    // Fail closed while agentBackends / configurationMode is unknown for Claude.
    expect(source).toContain("claudeConfigurationModeUnresolved")
    expect(source).toContain("agentBackendsModeReady")
  })

  test("model overrides use the shared catalog-only control (issues #821, #838)", () => {
    const source = indexSource()
    // Presentation metadata still travels with the catalog so the shared
    // control can label profiles while persisting executable ids. How that
    // markup renders is asserted in agent-model-select.test.tsx.
    expect(source).toContain(
      "models: { id: true, thinkingLevels: true, name: true, kind: true }",
    )
    expect(source).toContain("<AgentModelSelect")
    expect(source).toContain('name="defaultModel"')
    expect(source).toContain('name="reviewModel"')
  })

  test("Settings open refreshes indefinitely cached mode and catalog (issue #838)", () => {
    const source = indexSource()
    const openSettings = source.slice(
      source.indexOf("const openSettings = () => {"),
      source.indexOf("const harnessDefaultBackendId"),
    )
    expect(openSettings).toContain("void models.refetch()")
    expect(openSettings).toContain("void agentBackends.refetch()")
  })
})
