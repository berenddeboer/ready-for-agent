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
})
